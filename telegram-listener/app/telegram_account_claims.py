"""Permanent Telegram identity binding — one Telegram account per TScopier user."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from .admin_access import user_is_admin

TELEGRAM_ALREADY_LINKED = "TELEGRAM_ALREADY_LINKED"


def claim_conflict_allows_override(
    supabase: Any, user_id: str, exc: BaseException
) -> bool:
    """True only when the refusal was the already-linked claim AND this user is an admin.

    Anything else raised while checking availability (a database problem, bad
    input) returns False so the caller re-raises it: a read failure must never
    look like a conflict, and a conflict must never be waved through for a
    non-admin.
    """
    if str(exc) != TELEGRAM_ALREADY_LINKED:
        return False
    return user_is_admin(supabase, user_id)


def normalize_telegram_phone(raw: str) -> str:
    compact = re.sub(r"[\s\-()]", "", str(raw or "").strip())
    if compact.startswith("00"):
        return f"+{compact[2:]}"
    return compact


def _row_user_id(row: dict[str, Any] | None) -> str | None:
    if not row:
        return None
    uid = row.get("user_id")
    return str(uid) if uid else None


def assert_telegram_account_available(
    supabase: Any,
    user_id: str,
    *,
    phone: str | None = None,
    telegram_user_id: int | str | None = None,
) -> None:
    normalized_phone = normalize_telegram_phone(phone) if phone else ""
    if normalized_phone:
        row = (
            supabase.table("telegram_account_claims")
            .select("user_id")
            .eq("phone_number_normalized", normalized_phone)
            .maybe_single()
            .execute()
        ).data
        owner = _row_user_id(row)
        if owner and owner != user_id:
            raise ValueError(TELEGRAM_ALREADY_LINKED)

    if telegram_user_id is not None and str(telegram_user_id).strip():
        row = (
            supabase.table("telegram_account_claims")
            .select("user_id")
            .eq("telegram_user_id", int(telegram_user_id))
            .maybe_single()
            .execute()
        ).data
        owner = _row_user_id(row)
        if owner and owner != user_id:
            raise ValueError(TELEGRAM_ALREADY_LINKED)


def list_conflicting_telegram_claims(
    supabase: Any,
    user_id: str,
    *,
    phone: str | None = None,
    telegram_user_id: int | str | None = None,
) -> list[dict[str, Any]]:
    """Claim rows held by SOMEONE ELSE that bind this phone or Telegram id.

    Rows come back in full so a release can be undone if the link that
    triggered it fails afterwards.
    """
    normalized_phone = normalize_telegram_phone(phone) if phone else ""
    conflicts: dict[str, dict[str, Any]] = {}

    def collect(rows: Any) -> None:
        for row in rows or []:
            owner = _row_user_id(row)
            if owner and owner != user_id:
                conflicts[owner] = row

    if normalized_phone:
        collect(
            (
                supabase.table("telegram_account_claims")
                .select("*")
                .eq("phone_number_normalized", normalized_phone)
                .execute()
            ).data
        )

    if telegram_user_id is not None and str(telegram_user_id).strip():
        collect(
            (
                supabase.table("telegram_account_claims")
                .select("*")
                .eq("telegram_user_id", int(telegram_user_id))
                .execute()
            ).data
        )

    return list(conflicts.values())


def release_conflicting_telegram_claims(
    supabase: Any,
    user_id: str,
    *,
    phone: str | None = None,
    telegram_user_id: int | str | None = None,
) -> list[dict[str, Any]]:
    """Admin-only takeover: drop the claims another user holds on this Telegram.

    Nothing else about the other account is touched — their session keeps
    running. Callers must only reach this when an admin override is active.
    """
    conflicts = list_conflicting_telegram_claims(
        supabase, user_id, phone=phone, telegram_user_id=telegram_user_id
    )
    if not conflicts:
        return []
    supabase.table("telegram_account_claims").delete().in_(
        "user_id", [row["user_id"] for row in conflicts]
    ).execute()
    return conflicts


def restore_telegram_account_claims(supabase: Any, rows: list[dict[str, Any]]) -> None:
    """Put released claim rows back — used when the link that released them failed."""
    if not rows:
        return
    supabase.table("telegram_account_claims").insert(
        [
            {
                "user_id": row["user_id"],
                "telegram_user_id": row.get("telegram_user_id"),
                "phone_number_normalized": row["phone_number_normalized"],
                "linked_at": row.get("linked_at")
                or datetime.now(timezone.utc).isoformat(),
            }
            for row in rows
        ]
    ).execute()


def upsert_telegram_account_claim(
    supabase: Any,
    user_id: str,
    *,
    phone: str,
    telegram_user_id: int,
) -> None:
    normalized_phone = normalize_telegram_phone(phone)
    supabase.table("telegram_account_claims").upsert(
        {
            "user_id": user_id,
            "telegram_user_id": int(telegram_user_id),
            "phone_number_normalized": normalized_phone,
        },
        on_conflict="user_id",
    ).execute()
