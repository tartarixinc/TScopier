"""Telethon auth (send_code / verify_code) — mirrors TS worker HTTP contract."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from supabase import Client
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

from .config import Config
from .listener_events import persist_listener_event
from .telegram_account_claims import (
    assert_telegram_account_available,
    claim_conflict_allows_override,
    list_conflicting_telegram_claims,
    normalize_telegram_phone,
    release_conflicting_telegram_claims,
    restore_telegram_account_claims,
    upsert_telegram_account_claim,
)


@dataclass
class PendingAuth:
    client: TelegramClient
    phone: str
    phone_code_hash: str
    created_at: float


class AuthService:
    PENDING_TTL_S = 600

    def __init__(self, cfg: Config, supabase: Client, session_manager: Any) -> None:
        self.cfg = cfg
        self.supabase = supabase
        self.session_manager = session_manager
        self._pending: dict[str, PendingAuth] = {}

    async def send_code(self, user_id: str, phone: str) -> dict[str, str]:
        normalized_phone = normalize_telegram_phone(phone)
        # The claim check runs first, exactly as it did before overrides
        # existed, so an unblocked attempt does no extra work. Admin status is
        # only read once this number has already been refused — and only the
        # refusal itself (never a database problem) can open that door.
        try:
            assert_telegram_account_available(self.supabase, user_id, phone=normalized_phone)
        except ValueError as exc:
            if not claim_conflict_allows_override(self.supabase, user_id, exc):
                raise
            # Admin: the request proceeds. Nothing is unbound here — the other
            # account's claim is released only when this login completes, so
            # asking for a code can never release anyone. This lookup only
            # feeds a log line, so it must never fail the request.
            try:
                conflicts = list_conflicting_telegram_claims(
                    self.supabase, user_id, phone=normalized_phone
                )
                if conflicts:
                    print(
                        f"[auth_service] send_code admin claim override user={user_id} "
                        f"previous_owners={[row['user_id'] for row in conflicts]}"
                    )
            except Exception as lookup_exc:
                print(
                    f"[auth_service] send_code conflict lookup failed user={user_id}: {lookup_exc}"
                )
        await self._cleanup_pending(user_id)
        client = TelegramClient(
            StringSession(""),
            self.cfg.telegram_api_id,
            self.cfg.telegram_api_hash,
        )
        await client.connect()
        result = await client.send_code_request(normalized_phone)
        self._pending[user_id] = PendingAuth(
            client=client,
            phone=normalized_phone,
            phone_code_hash=result.phone_code_hash,
            created_at=asyncio.get_event_loop().time(),
        )
        expires = (datetime.now(timezone.utc) + timedelta(minutes=12)).isoformat()
        self.supabase.table("telegram_auth_pending").upsert(
            {
                "user_id": user_id,
                "phone": normalized_phone,
                "phone_code_hash": result.phone_code_hash,
                "expires_at": expires,
                "awaiting_password": False,
            },
            on_conflict="user_id",
        ).execute()
        return {"phone_code_hash": result.phone_code_hash}

    async def verify_code(
        self, user_id: str, phone: str, code: str, password: str | None = None
    ) -> dict[str, Any]:
        pending = self._pending.get(user_id)
        if not pending:
            pending = await self._recover_pending(user_id, phone)
        if not pending:
            raise ValueError("No pending auth — send code first")

        try:
            await pending.client.sign_in(
                phone=pending.phone,
                code=code,
                phone_code_hash=pending.phone_code_hash,
            )
        except SessionPasswordNeededError:
            if not password:
                session_str = pending.client.session.save()
                self.supabase.table("telegram_auth_pending").upsert(
                    {
                        "user_id": user_id,
                        "phone": pending.phone,
                        "phone_code_hash": pending.phone_code_hash,
                        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=12)).isoformat(),
                        "awaiting_password": True,
                        "auth_session_string": session_str,
                    },
                    on_conflict="user_id",
                ).execute()
                return {"requires_password": True}
            await pending.client.sign_in(password=password)

        session_string = pending.client.session.save()
        self._pending.pop(user_id, None)
        self.supabase.table("telegram_auth_pending").delete().eq("user_id", user_id).execute()

        me = await pending.client.get_me()
        telegram_user_id = int(me.id)
        # The claim check runs first, exactly as it did before overrides
        # existed, so an unblocked link does no extra work. The override is
        # consulted only when this Telegram has already been refused, and only
        # the refusal itself can open that door. The release happens once this
        # link has a persisted session below, so a login that never finishes
        # leaves the other account untouched.
        admin_override = False
        try:
            assert_telegram_account_available(
                self.supabase,
                user_id,
                phone=pending.phone,
                telegram_user_id=telegram_user_id,
            )
        except ValueError as exc:
            if not claim_conflict_allows_override(self.supabase, user_id, exc):
                raise
            admin_override = True
            print(
                f"[auth_service] admin override granted user={user_id} "
                f"telegram_user_id={telegram_user_id}"
            )

        self.supabase.table("telegram_sessions").upsert(
            {
                "user_id": user_id,
                "session_string": session_string,
                "phone_number": pending.phone,
                "is_active": True,
                "listener_engine": "telethon",
            },
            on_conflict="user_id",
        ).execute()

        released_claims: list[dict[str, Any]] = []
        try:
            if admin_override:
                released_claims = release_conflicting_telegram_claims(
                    self.supabase,
                    user_id,
                    phone=pending.phone,
                    telegram_user_id=telegram_user_id,
                )
                if released_claims:
                    print(
                        f"[auth_service] admin claim override user={user_id} "
                        f"previous_owners={[row['user_id'] for row in released_claims]}"
                    )
                    # Recorded BEFORE the claim below is written: if this
                    # process dies in between, the takeover is still on record.
                    # persist_listener_event logs its own failures, so this can
                    # never fail the link.
                    persist_listener_event(
                        self.supabase,
                        user_id=user_id,
                        event_type="telegram_link_attempt",
                        detail={
                            "action": "admin_claim_override_released",
                            "previous_owner_user_ids": [
                                row["user_id"] for row in released_claims
                            ],
                            "telegram_user_id": telegram_user_id,
                            "phone_masked": f"{pending.phone[:4]}****"
                            if pending.phone
                            else None,
                        },
                    )
            upsert_telegram_account_claim(
                self.supabase,
                user_id,
                phone=pending.phone,
                telegram_user_id=telegram_user_id,
            )
        except Exception:
            # A takeover that fails must not leave the other account unbound.
            if released_claims:
                try:
                    restore_telegram_account_claims(self.supabase, released_claims)
                    print(
                        f"[auth_service] released claims restored user={user_id} "
                        f"owners={[row['user_id'] for row in released_claims]}"
                    )
                except Exception as restore_exc:
                    print(
                        f"[auth_service] claim restore failed user={user_id}: {restore_exc}"
                    )
                    persist_listener_event(
                        self.supabase,
                        user_id=user_id,
                        event_type="telegram_link_failed",
                        detail={
                            "step": "finalize_override_restore",
                            "error": str(restore_exc),
                        },
                    )
            if admin_override:
                # A link that was allowed through but did not complete must not
                # leave a session row behind for a Telegram we failed to claim
                # (the release itself may have failed before anything was
                # restored). Gated on the override only, so a normal claim
                # failure keeps behaving exactly as it did before.
                try:
                    self.supabase.table("telegram_sessions").delete().eq(
                        "user_id", user_id
                    ).execute()
                except Exception as session_exc:
                    print(
                        f"[auth_service] session rollback failed user={user_id}: {session_exc}"
                    )
            raise

        if released_claims:
            persist_listener_event(
                self.supabase,
                user_id=user_id,
                event_type="telegram_link_success",
                detail={
                    "session_id": user_id,
                    "method": "phone",
                    "admin_claim_override": {
                        "previous_owner_user_ids": [
                            row["user_id"] for row in released_claims
                        ],
                        "telegram_user_id": telegram_user_id,
                        "phone_masked": f"{pending.phone[:4]}****"
                        if pending.phone
                        else None,
                    },
                },
            )

        await self.session_manager.adopt_client(user_id, pending.client, session_string)
        channels = await self.session_manager.list_channels(user_id)
        return {"ok": True, "session_id": user_id, "channels": channels}

    async def _recover_pending(self, user_id: str, phone: str) -> PendingAuth | None:
        row = (
            self.supabase.table("telegram_auth_pending")
            .select("*")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        ).data
        if not row:
            return None
        auth_session = row.get("auth_session_string") or ""
        session = StringSession(auth_session) if auth_session else StringSession("")
        client = TelegramClient(session, self.cfg.telegram_api_id, self.cfg.telegram_api_hash)
        await client.connect()
        pending = PendingAuth(
            client=client,
            phone=str(row.get("phone") or phone).strip(),
            phone_code_hash=str(row.get("phone_code_hash") or ""),
            created_at=asyncio.get_event_loop().time(),
        )
        self._pending[user_id] = pending
        return pending

    async def _cleanup_pending(self, user_id: str) -> None:
        old = self._pending.pop(user_id, None)
        if old:
            await old.client.disconnect()
