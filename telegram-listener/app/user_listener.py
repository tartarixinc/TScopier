"""Per-user Telethon listener — live events, poll backstop, catch-up."""

from __future__ import annotations

import asyncio
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Awaitable

from supabase import Client
from telethon import TelegramClient, events
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.types import Channel, Chat

from telethon.sessions import StringSession

from . import metrics
from .config import Config
from .listener_events import persist_listener_event
from .signal_heuristic import looks_like_trading_signal
from .trade_client import TradeClient


def is_numeric_chat_id(value: str | None) -> bool:
    return bool(value and re.match(r"^-?\d+$", value.strip()))


def is_valid_username(value: str | None) -> bool:
    if not value:
        return False
    u = value.strip().lstrip("@")
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9_]{3,31}$", u))


def normalize_username(value: str | None) -> str:
    return (value or "").strip().lstrip("@").lower()


def channel_id_variants(chat_id: str) -> list[str]:
    cid = chat_id.strip()
    out = {cid}
    if cid.startswith("-100"):
        out.add(cid[4:])
        out.add(f"-{cid[4:]}")
    elif cid.startswith("-"):
        rest = cid[1:]
        out.add(f"-100{rest}")
        out.add(rest)
    else:
        out.add(f"-{cid}")
        out.add(f"-100{cid}")
    return list(out)


@dataclass
class ChannelRow:
    id: str
    channel_id: str
    channel_username: str
    last_seen_message_id: int | None = None
    last_seen_at: str | None = None


@dataclass
class ListenerStatus:
    user_id: str
    connected: bool
    last_event_at: float
    last_successful_poll_at: float
    monitored_channels: int
    consecutive_probe_failures: int = 0


@dataclass
class UserListener:
    user_id: str
    session_string: str
    supabase: Client
    cfg: Config
    trade: TradeClient
    client: TelegramClient | None = None
    monitored_keys: set[str] = field(default_factory=set)
    channel_rows: list[ChannelRow] = field(default_factory=list)
    last_event_at: float = 0
    last_successful_poll_at: float = 0
    is_connected: bool = False
    _poll_task: asyncio.Task | None = None
    _handler_registered: bool = False

    async def start(self, *, already_connected: bool = False) -> None:
        if not self.client:
            self.client = TelegramClient(
                StringSession(self.session_string),
                self.cfg.telegram_api_id,
                self.cfg.telegram_api_hash,
            )
        assert self.client is not None
        if not already_connected:
            await self.client.connect()
        if not await self.client.is_user_authorized():
            raise RuntimeError("Telegram session not authorized")
        self.is_connected = True
        self.last_event_at = asyncio.get_event_loop().time()
        await self.refresh_channels()
        await self._register_handler()
        await self.sync_dialogs()
        await self.warm_all_monitored_entities()
        asyncio.create_task(self.run_catchup())
        self._poll_task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
        if self.client and self._handler_registered:
            self.client.remove_event_handler(self._on_message)
        if self.client:
            await self.client.disconnect()
        self.is_connected = False

    def get_status(self) -> ListenerStatus:
        return ListenerStatus(
            user_id=self.user_id,
            connected=self.is_connected,
            last_event_at=self.last_event_at,
            last_successful_poll_at=self.last_successful_poll_at,
            monitored_channels=len(self.monitored_keys),
        )

    def is_healthy(self, stale_ms: float) -> bool:
        now = asyncio.get_event_loop().time()
        last = max(self.last_event_at, self.last_successful_poll_at)
        return self.is_connected and (last == 0 or (now - last) * 1000 < stale_ms)

    async def on_channels_changed(self) -> None:
        await self.refresh_channels()
        await self.warm_all_monitored_entities()
        await self.run_catchup()

    async def list_channels(self) -> list[dict[str, Any]]:
        assert self.client
        out: list[dict[str, Any]] = []
        async for dialog in self.client.iter_dialogs(limit=500):
            if not dialog.is_channel and not dialog.is_group:
                continue
            entity = dialog.entity
            username = getattr(entity, "username", None) or ""
            members = getattr(entity, "participants_count", 0) or 0
            out.append(
                {
                    "id": str(dialog.id),
                    "title": dialog.title or "Unknown",
                    "username": username,
                    "members_count": members,
                }
            )
        return out

    async def refresh_channels(self) -> None:
        result = (
            self.supabase.table("telegram_channels")
            .select("id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at")
            .eq("user_id", self.user_id)
            .eq("is_active", True)
            .execute()
        )
        rows = [
            ChannelRow(
                id=str(r["id"]),
                channel_id=str(r.get("channel_id") or ""),
                channel_username=str(r.get("channel_username") or ""),
                last_seen_message_id=r.get("last_seen_message_id"),
                last_seen_at=r.get("last_seen_at"),
            )
            for r in (result.data or [])
        ]
        self.channel_rows = rows
        keys: set[str] = set()
        for row in rows:
            if is_numeric_chat_id(row.channel_id):
                for v in channel_id_variants(row.channel_id):
                    keys.add(v)
            if is_valid_username(row.channel_username):
                keys.add(normalize_username(row.channel_username))
        self.monitored_keys = keys

    async def sync_dialogs(self) -> None:
        """Warm entity cache after connect."""
        assert self.client
        try:
            await self.client.get_dialogs(limit=200)
            await self.warm_all_monitored_entities()
        except Exception as exc:
            print(f"[user_listener] sync_dialogs failed user={self.user_id}: {exc}")

    async def ensure_joined_public_channel(self, row: ChannelRow) -> None:
        username = normalize_username(row.channel_username)
        if not username or not self.client:
            return
        try:
            entity = await self.client.get_input_entity(username)
            await self.client(JoinChannelRequest(entity))
            metrics.inc("channel_join_ok")
        except Exception as exc:
            msg = str(exc)
            if "already" in msg.lower() or "USER_ALREADY_PARTICIPANT" in msg:
                return
            print(f"[user_listener] join @{username} failed: {msg[:200]}")

    async def warm_all_monitored_entities(self) -> None:
        await self.refresh_channels()
        for row in self.channel_rows:
            await self.ensure_joined_public_channel(row)
            await self.warm_channel_entity(row)

    async def _register_handler(self) -> None:
        assert self.client
        if self._handler_registered:
            return
        self.client.add_event_handler(self._on_message, events.NewMessage())
        self._handler_registered = True

    async def _on_message(self, event: events.NewMessage.Event) -> None:
        self.last_event_at = asyncio.get_event_loop().time()
        metrics.inc("telegram_live_events")
        message = event.message
        if not message:
            return
        chat_id, username, variants = await self._resolve_chat(event)
        if not chat_id and not username:
            return
        monitored = any(v in self.monitored_keys for v in variants) or (
            username and username in self.monitored_keys
        )
        if not monitored:
            return
        row = self._resolve_channel_row(variants, username)
        if not row:
            persist_listener_event(
                self.supabase,
                user_id=self.user_id,
                event_type="unmapped_channel",
                telegram_message_id=str(message.id),
                detail={"chat_id": chat_id, "username": username, "variants": variants},
            )
            return
        await self.process_message(row, message, source="live")
        await self._bump_last_live(row.id)

    async def _resolve_chat(self, event: events.NewMessage.Event) -> tuple[str, str, list[str]]:
        chat_id = str(event.chat_id) if event.chat_id is not None else ""
        username = ""
        try:
            chat = await event.get_chat()
            if isinstance(chat, (Channel, Chat)):
                chat_id = str(chat.id)
                username = normalize_username(getattr(chat, "username", None))
        except Exception:
            pass
        return chat_id, username, channel_id_variants(chat_id) if chat_id else []

    def _resolve_channel_row(self, variants: list[str], username: str) -> ChannelRow | None:
        variant_set = set(variants)
        matches: list[ChannelRow] = []
        for row in self.channel_rows:
            stored = str(row.channel_id or "").strip()
            if stored and is_numeric_chat_id(stored):
                if any(v in variant_set for v in channel_id_variants(stored)):
                    matches.append(row)
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            # Prefer exact chat id match over variant overlap (legacy mis-stored ids).
            for row in matches:
                stored = str(row.channel_id or "").strip()
                if stored in variant_set:
                    persist_listener_event(
                        self.supabase,
                        user_id=self.user_id,
                        event_type="channel_row_ambiguous",
                        channel_row_id=row.id,
                        detail={
                            "chat_variants": list(variant_set)[:8],
                            "matched_rows": [r.id for r in matches],
                            "picked": row.id,
                        },
                    )
                    return row
            return matches[0]
        if username:
            for row in self.channel_rows:
                if normalize_username(row.channel_username) == username:
                    return row
        return None

    async def process_message(self, row: ChannelRow, message: Any, *, source: str) -> None:
        message_id = str(message.id)
        raw = (message.message or message.text or "").strip()
        is_reply = bool(getattr(message, "reply_to", None))
        msg_date = getattr(message, "date", None)
        if source == "catchup" and msg_date:
            age_min = (datetime.now(timezone.utc) - msg_date.replace(tzinfo=timezone.utc)).total_seconds() / 60
            if age_min > self.cfg.catchup_max_age_minutes:
                await self._bump_last_seen(row.id, message_id)
                return

        if not raw.strip():
            persist_listener_event(
                self.supabase,
                user_id=self.user_id,
                event_type="image_only_message",
                channel_row_id=row.id,
                telegram_message_id=message_id,
                detail={"source": source, "hint": "Telethon has no OCR; text-only signals required"},
            )
            return

        if not looks_like_trading_signal(raw, is_reply):
            persist_listener_event(
                self.supabase,
                user_id=self.user_id,
                event_type="heuristic_rejected",
                channel_row_id=row.id,
                telegram_message_id=message_id,
                detail={
                    "source": source,
                    "preview": raw[:160],
                    "is_reply": is_reply,
                },
            )
            await self._persist_skip(row, message_id, raw, is_reply)
            return

        dup = (
            self.supabase.table("signals")
            .select("id", count="exact")
            .eq("user_id", self.user_id)
            .eq("channel_id", row.id)
            .eq("telegram_message_id", message_id)
            .execute()
        )
        if (dup.count or 0) > 0:
            persist_listener_event(
                self.supabase,
                user_id=self.user_id,
                event_type="duplicate_message_skipped",
                channel_row_id=row.id,
                telegram_message_id=message_id,
                detail={
                    "source": source,
                    "preview": raw[:160],
                    "scope": "user_id+channel_id+telegram_message_id",
                },
            )
            return

        signal_id = str(uuid.uuid4())
        try:
            parsed = await self.trade.parse_signal(
                channel_row_id=row.id, raw_message=raw, user_id=self.user_id
            )
        except Exception as exc:
            print(
                f"[user_listener] parse failed user={self.user_id} channel={row.id}"
                f" signal={signal_id}: {exc}",
            )
            persist_listener_event(
                self.supabase,
                user_id=self.user_id,
                event_type="parse_http_failed",
                channel_row_id=row.id,
                telegram_message_id=message_id,
                detail={"error": str(exc)[:300], "signal_id": signal_id},
            )
            await self._persist_row(
                signal_id, row, message_id, raw, is_reply, status="error", skip_reason=str(exc)
            )
            return

        status = str(parsed.get("status") or "skipped")
        parsed_data = parsed.get("parsed")
        skip_reason = parsed.get("skip_reason")
        await self._persist_row(
            signal_id,
            row,
            message_id,
            raw,
            is_reply,
            status=status,
            parsed_data=parsed_data,
            skip_reason=skip_reason,
        )
        if status != "parsed" or not parsed_data:
            return

        dispatch_row = {
            "id": signal_id,
            "user_id": self.user_id,
            "channel_id": row.id,
            "parsed_data": parsed_data,
            "status": status,
            "telegram_message_id": message_id,
            "is_modification": is_reply,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        ok = await self.trade.dispatch_signal(dispatch_row)
        if not ok:
            metrics.inc("dispatch_push_exhausted")

    async def _persist_skip(self, row: ChannelRow, message_id: str, raw: str, is_reply: bool) -> None:
        await self._persist_row(
            str(uuid.uuid4()),
            row,
            message_id,
            raw,
            is_reply,
            status="skipped",
            skip_reason="non_trade_message",
            parsed_data={"action": "ignore"},
        )

    async def _persist_row(
        self,
        signal_id: str,
        row: ChannelRow,
        message_id: str,
        raw: str,
        is_reply: bool,
        *,
        status: str,
        parsed_data: Any = None,
        skip_reason: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "id": signal_id,
            "user_id": self.user_id,
            "channel_id": row.id,
            "raw_message": raw,
            "status": status,
            "telegram_message_id": message_id,
            "is_modification": is_reply,
        }
        if parsed_data is not None:
            payload["parsed_data"] = parsed_data
        if skip_reason:
            payload["skip_reason"] = skip_reason
        try:
            self.supabase.table("signals").upsert(
                payload, on_conflict="user_id,channel_id,telegram_message_id"
            ).execute()
        except Exception as exc:
            persist_listener_event(
                self.supabase,
                user_id=self.user_id,
                event_type="signal_persist_failed",
                channel_row_id=row.id,
                telegram_message_id=message_id,
                detail={"error": str(exc)[:400], "signal_id": signal_id, "status": status},
            )
            print(
                f"[user_listener] signal persist failed user={self.user_id} channel={row.id}"
                f" msg={message_id}: {exc}",
            )
            return
        await self._bump_last_seen(row.id, message_id)

    async def _bump_last_seen(self, channel_row_id: str, message_id: str) -> None:
        try:
            num = int(message_id)
        except ValueError:
            return
        self.supabase.table("telegram_channels").update(
            {
                "last_seen_message_id": num,
                "last_seen_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", channel_row_id).execute()

    async def _bump_last_live(self, channel_row_id: str) -> None:
        self.supabase.table("telegram_channels").update(
            {"last_live_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", channel_row_id).execute()

    async def _resolve_peer(self, row: ChannelRow) -> Any:
        assert self.client
        key = normalize_username(row.channel_username) or row.channel_id
        return await self.client.get_input_entity(key)

    async def poll_channel(self, row: ChannelRow) -> None:
        assert self.client
        try:
            peer = await self._resolve_peer(row)
        except Exception as exc:
            persist_listener_event(
                self.supabase,
                user_id=self.user_id,
                event_type="poll_peer_resolve_failed",
                channel_row_id=row.id,
                detail={"error": str(exc)[:300]},
            )
            return
        min_id = int(row.last_seen_message_id or 0)
        try:
            messages = await self.client.get_messages(
                peer, limit=20 if min_id == 0 else 30, min_id=min_id if min_id > 0 else None
            )
        except Exception as exc:
            persist_listener_event(
                self.supabase,
                user_id=self.user_id,
                event_type="poll_error",
                channel_row_id=row.id,
                detail={"error": str(exc)[:300], "min_id": min_id},
            )
            return
        self.last_successful_poll_at = asyncio.get_event_loop().time()
        if not messages:
            return
        sorted_msgs = sorted(messages, key=lambda m: m.id)
        if min_id == 0 and sorted_msgs:
            latest = sorted_msgs[-1]
            await self._bump_last_seen(row.id, str(latest.id))
            now = datetime.now(timezone.utc)
            for m in sorted_msgs:
                if m.date and (now - m.date.replace(tzinfo=timezone.utc)).total_seconds() <= 15 * 60:
                    await self.process_message(row, m, source="catchup")
            return
        for m in sorted_msgs:
            if m.id > min_id:
                await self.process_message(row, m, source="catchup")

    async def _poll_loop(self) -> None:
        interval = self.cfg.safety_poll_interval_ms / 1000
        while self.is_connected:
            try:
                await self.warm_all_monitored_entities()
                await self.refresh_channels()
                for row in self.channel_rows:
                    await self.poll_channel(row)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[user_listener] poll loop error user={self.user_id}: {exc}")
            await asyncio.sleep(interval)

    async def run_catchup(self) -> None:
        await self.refresh_channels()
        for row in self.channel_rows:
            if not row.last_seen_at:
                await self.poll_channel(row)

    async def warm_channel_entity(self, row: ChannelRow) -> None:
        try:
            await self._resolve_peer(row)
        except Exception as exc:
            persist_listener_event(
                self.supabase,
                user_id=self.user_id,
                event_type="peer_resolve_failed",
                channel_row_id=row.id,
                detail={"error": str(exc)[:300]},
            )
