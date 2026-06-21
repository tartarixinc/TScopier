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
from .telegram_account_claims import (
    assert_telegram_account_available,
    normalize_telegram_phone,
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
        assert_telegram_account_available(self.supabase, user_id, phone=normalized_phone)
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
        assert_telegram_account_available(
            self.supabase,
            user_id,
            phone=pending.phone,
            telegram_user_id=telegram_user_id,
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

        upsert_telegram_account_claim(
            self.supabase,
            user_id,
            phone=pending.phone,
            telegram_user_id=telegram_user_id,
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
