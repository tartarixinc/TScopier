"""Poll-based detection for silent Telegram message edits."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

from supabase import Client

EDIT_SWEEP_WINDOW_MS = max(
    60_000,
    min(24 * 60 * 60_000, int(os.getenv("TELEGRAM_EDIT_SWEEP_WINDOW_MS", str(4 * 60 * 60_000)))),
)
EDIT_SWEEP_INTERVAL_MS = max(
    10_000,
    min(120_000, int(os.getenv("TELEGRAM_EDIT_SWEEP_MS", "30000"))),
)
EDIT_SWEEP_MAX_SIGNALS = max(
    10,
    min(200, int(os.getenv("TELEGRAM_EDIT_SWEEP_MAX_SIGNALS", "80"))),
)
EDIT_POLL_HOOK_WINDOW_MS = max(
    30_000,
    min(6 * 60 * 60_000, int(os.getenv("TELEGRAM_EDIT_POLL_HOOK_WINDOW_MS", str(2 * 60 * 60_000)))),
)
EDIT_POLL_HOOK_MAX_SIGNALS = max(
    5,
    min(50, int(os.getenv("TELEGRAM_EDIT_POLL_HOOK_MAX_SIGNALS", "20"))),
)
TELEGRAM_MESSAGE_ID_BATCH_SIZE = 100
EDIT_SWEEP_STATUSES = ("parsed", "executed")


def message_text_changed(stored: str, fetched: str) -> bool:
    return stored.strip() != fetched.strip()


def telegram_edit_date_sec(message: Any) -> int | None:
    raw = getattr(message, "edit_date", None)
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return int(raw.timestamp())
    try:
        n = int(raw)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def telegram_message_text(message: Any) -> str:
    return str(getattr(message, "message", None) or getattr(message, "text", None) or "").strip()


def should_check_message_for_edit(
    stored_raw: str,
    stored_edit_date: int | None,
    fetched_text: str,
    fetched_edit_date: int | None,
) -> bool:
    if (
        stored_edit_date
        and stored_edit_date > 0
        and fetched_edit_date
        and fetched_edit_date > 0
        and fetched_edit_date <= stored_edit_date
        and not message_text_changed(stored_raw, fetched_text)
    ):
        return False
    return message_text_changed(stored_raw, fetched_text)


def chunk_telegram_message_ids(ids: list[str]) -> list[list[str]]:
    unique = list(dict.fromkeys(id.strip() for id in ids if id and id.strip()))
    chunks: list[list[str]] = []
    for i in range(0, len(unique), TELEGRAM_MESSAGE_ID_BATCH_SIZE):
        chunks.append(unique[i : i + TELEGRAM_MESSAGE_ID_BATCH_SIZE])
    return chunks


def load_signals_for_edit_sweep(
    supabase: Client,
    *,
    user_id: str,
    window_ms: int | None = None,
    max_signals: int | None = None,
    channel_row_id: str | None = None,
) -> list[dict[str, Any]]:
    window = window_ms if window_ms is not None else EDIT_SWEEP_WINDOW_MS
    cap = max_signals if max_signals is not None else EDIT_SWEEP_MAX_SIGNALS
    since = (datetime.now(timezone.utc) - timedelta(milliseconds=window)).isoformat()

    open_result = (
        supabase.table("trades")
        .select("signal_id")
        .eq("user_id", user_id)
        .eq("status", "open")
        .gte("opened_at", since)
        .limit(500)
        .execute()
    )
    open_signal_ids = {
        str(r.get("signal_id"))
        for r in (open_result.data or [])
        if r.get("signal_id")
    }

    select_with_edit = (
        "id,channel_id,telegram_message_id,raw_message,telegram_message_edit_date,created_at"
    )
    select_without_edit = "id,channel_id,telegram_message_id,raw_message,created_at"

    def _run_query(select: str):
        q = (
            supabase.table("signals")
            .select(select)
            .eq("user_id", user_id)
            .not_.is_("telegram_message_id", "null")
            .in_("status", list(EDIT_SWEEP_STATUSES))
            .gte("created_at", since)
            .order("created_at", desc=True)
            .limit(min(cap * 3, 240))
        )
        if channel_row_id:
            q = q.eq("channel_id", channel_row_id)
        return q.execute()

    try:
        result = _run_query(select_with_edit)
    except Exception as exc:
        if "telegram_message_edit_date" not in str(exc):
            raise
        result = _run_query(select_without_edit)
    rows = [r for r in (result.data or []) if r.get("channel_id") and r.get("telegram_message_id")]

    prioritized = [r for r in rows if str(r.get("id")) in open_signal_ids]
    prioritized.extend(r for r in rows if str(r.get("id")) not in open_signal_ids)

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in prioritized:
        sid = str(row.get("id") or "")
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(row)
        if len(out) >= cap:
            break
    return out


def find_edited_signals(
    signals: list[dict[str, Any]],
    telegram_by_message_id: dict[str, tuple[str, int | None]],
) -> list[tuple[dict[str, Any], str, int | None]]:
    edited: list[tuple[dict[str, Any], str, int | None]] = []
    for signal in signals:
        mid = str(signal.get("telegram_message_id") or "").strip()
        if not mid:
            continue
        snap = telegram_by_message_id.get(mid)
        if not snap:
            continue
        fetched_text, fetched_edit = snap
        stored_edit = signal.get("telegram_message_edit_date")
        stored_edit_int = int(stored_edit) if stored_edit else None
        if not should_check_message_for_edit(
            str(signal.get("raw_message") or ""),
            stored_edit_int,
            fetched_text,
            fetched_edit,
        ):
            continue
        edited.append((signal, fetched_text, fetched_edit))
    return edited
