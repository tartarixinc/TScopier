"""Poll-based signal ↔ Telegram text reconciliation."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

RECONCILE_SWEEP_WINDOW_MS = max(
    60_000,
    min(24 * 60 * 60_000, int(os.getenv("SIGNAL_RECONCILE_WINDOW_MS", str(6 * 60 * 60_000)))),
)
RECONCILE_SWEEP_INTERVAL_MS = max(
    15_000,
    min(300_000, int(os.getenv("SIGNAL_RECONCILE_SWEEP_MS", "60000"))),
)
RECONCILE_SWEEP_MAX_SIGNALS = max(
    10,
    min(300, int(os.getenv("SIGNAL_RECONCILE_MAX_SIGNALS", "100"))),
)
TELEGRAM_MESSAGE_ID_BATCH_SIZE = 100


def _message_text_changed(stored: str, fetched: str) -> bool:
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


from .normalize_telegram_message_text import normalize_telegram_message_text, telegram_message_text


def should_reconcile_signal(stored: dict[str, Any], snap: dict[str, Any]) -> bool:
    stored_edit = stored.get("telegram_edit_date_seen")
    fetched_edit = snap.get("edit_date_sec")
    if (
        isinstance(stored_edit, int)
        and stored_edit > 0
        and isinstance(fetched_edit, int)
        and fetched_edit > 0
        and fetched_edit <= stored_edit
        and not _message_text_changed(str(stored.get("raw_message") or ""), str(snap.get("text") or ""))
    ):
        return False
    return _message_text_changed(str(stored.get("raw_message") or ""), str(snap.get("text") or ""))


def chunk_telegram_message_ids(ids: list[str]) -> list[list[str]]:
    unique = list(dict.fromkeys(x.strip() for x in ids if x and x.strip()))
    return [
        unique[i : i + TELEGRAM_MESSAGE_ID_BATCH_SIZE]
        for i in range(0, len(unique), TELEGRAM_MESSAGE_ID_BATCH_SIZE)
    ]


def load_signals_for_reconcile(
    supabase: Any,
    *,
    user_id: str,
    window_ms: int | None = None,
    max_signals: int | None = None,
    channel_row_id: str | None = None,
) -> list[dict[str, Any]]:
    window = window_ms if window_ms is not None else RECONCILE_SWEEP_WINDOW_MS
    limit = max_signals if max_signals is not None else RECONCILE_SWEEP_MAX_SIGNALS
    since = (datetime.now(timezone.utc) - timedelta(milliseconds=window)).isoformat()

    open_res = (
        supabase.table("trades")
        .select("signal_id")
        .eq("user_id", user_id)
        .eq("status", "open")
        .gte("opened_at", since)
        .limit(500)
        .execute()
    )
    open_ids = {
        str(r.get("signal_id"))
        for r in (open_res.data or [])
        if r.get("signal_id")
    }

    query = (
        supabase.table("signals")
        .select("id,channel_id,telegram_message_id,raw_message,telegram_edit_date_seen,created_at")
        .eq("user_id", user_id)
        .not_.is_("telegram_message_id", "null")
        .in_("status", ["parsed", "executed"])
        .gte("created_at", since)
        .order("created_at", desc=True)
        .limit(min(limit * 3, 300))
    )
    if channel_row_id:
        query = query.eq("channel_id", channel_row_id)
    res = query.execute()
    rows = [r for r in (res.data or []) if r.get("channel_id") and r.get("telegram_message_id")]
    prioritized = [r for r in rows if str(r.get("id")) in open_ids] + [
        r for r in rows if str(r.get("id")) not in open_ids
    ]
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in prioritized:
        rid = str(row.get("id") or "")
        if not rid or rid in seen:
            continue
        seen.add(rid)
        out.append(row)
        if len(out) >= limit:
            break
    return out
