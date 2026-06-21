"""Permanent Telegram identity binding — one Telegram account per TScopier user."""

from __future__ import annotations

import re
from typing import Any

TELEGRAM_ALREADY_LINKED = "TELEGRAM_ALREADY_LINKED"


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
