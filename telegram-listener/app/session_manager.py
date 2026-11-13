"""Manages per-user Telethon listeners."""

from __future__ import annotations

import asyncio
from typing import Any

from supabase import Client, create_client
from telethon import TelegramClient
from telethon.sessions import StringSession

from .config import Config, user_belongs_to_shard
from .session_guard import session_value_or_refuse
from .session_lease import acquire_session_lease, list_active_leases, release_session_lease, renew_session_lease
from .trade_client import TradeClient
from .user_listener import UserListener


class SessionManager:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.supabase: Client = create_client(cfg.supabase_url, cfg.supabase_service_role_key)
        self.trade = TradeClient(cfg)
        self.listeners: dict[str, UserListener] = {}
        self._channel_subscription = None

    async def load_all(self) -> None:
        result = (
            self.supabase.table("telegram_sessions")
            .select("user_id, session_string, listener_engine")
            .eq("is_active", True)
            .execute()
        )
        sessions = [
            s
            for s in (result.data or [])
            if user_belongs_to_shard(str(s["user_id"]), self.cfg)
            and str(s.get("listener_engine") or "gramjs") == "telethon"
        ]
        print(f"[session_manager] loading {len(sessions)} telethon sessions")
        for s in sessions:
            session = session_value_or_refuse(str(s["user_id"]), s.get("session_string"))
            if session is None:
                continue
            try:
                await self.start_listener(str(s["user_id"]), session)
            except Exception as exc:
                print(f"[session_manager] failed start {s['user_id']}: {exc}")
        self._subscribe_channels()

    def _subscribe_channels(self) -> None:
        def on_change(payload: dict[str, Any]) -> None:
            record = payload.get("new") or payload.get("old") or {}
            user_id = record.get("user_id")
            if not user_id or not user_belongs_to_shard(str(user_id), self.cfg):
                return
            listener = self.listeners.get(str(user_id))
            if listener:
                asyncio.create_task(listener.on_channels_changed())

        self._channel_subscription = self.supabase.channel("telegram_channels_py").on_postgres_changes(
            event="*",
            schema="public",
            table="telegram_channels",
            callback=on_change,
        ).subscribe()

    async def sync_sessions(self) -> None:
        result = (
            self.supabase.table("telegram_sessions")
            .select("user_id, session_string, is_active, listener_engine")
            .execute()
        )
        active = {
            str(s["user_id"])
            for s in (result.data or [])
            if s.get("is_active")
            and user_belongs_to_shard(str(s["user_id"]), self.cfg)
            and str(s.get("listener_engine") or "gramjs") == "telethon"
        }
        for s in result.data or []:
            uid = str(s["user_id"])
            if uid in active and uid not in self.listeners:
                session = session_value_or_refuse(uid, s.get("session_string"))
                if session is None:
                    continue
                await self.start_listener(uid, session)
        for uid in list(self.listeners.keys()):
            if uid not in active:
                await self.stop_listener(uid)

    async def renew_all_leases(self) -> None:
        for uid, listener in self.listeners.items():
            if not listener.is_connected:
                continue
            renew_session_lease(self.supabase, self.cfg, uid)

    async def adopt_client(
        self, user_id: str, client: TelegramClient, session_string: str
    ) -> None:
        await self.stop_listener(user_id)
        listener = UserListener(
            user_id=user_id,
            session_string=session_string,
            supabase=self.supabase,
            cfg=self.cfg,
            trade=self.trade,
            client=client,
        )
        await listener.start(already_connected=True)
        self.listeners[user_id] = listener
        ok, reason = await acquire_session_lease(self.supabase, self.cfg, user_id)
        if not ok:
            print(f"[session_manager] lease warn user={user_id}: {reason}")

    async def start_listener(self, user_id: str, session_string: str) -> None:
        if user_id in self.listeners:
            return
        ok, reason = await acquire_session_lease(self.supabase, self.cfg, user_id)
        if not ok:
            print(f"[session_manager] skip listener user={user_id}: {reason}")
            return
        listener = UserListener(
            user_id=user_id,
            session_string=session_string,
            supabase=self.supabase,
            cfg=self.cfg,
            trade=self.trade,
        )
        try:
            await listener.start()
        except Exception:
            release_session_lease(self.supabase, self.cfg, user_id)
            raise
        self.listeners[user_id] = listener

    async def stop_listener(self, user_id: str) -> None:
        listener = self.listeners.pop(user_id, None)
        if listener:
            await listener.stop()
        release_session_lease(self.supabase, self.cfg, user_id)

    async def list_channels(self, user_id: str) -> list[dict[str, Any]]:
        listener = self.listeners.get(user_id)
        if listener:
            return await listener.list_channels()
        row = (
            self.supabase.table("telegram_sessions")
            .select("session_string")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        ).data
        if not row or not row.get("session_string"):
            raise RuntimeError("No Telegram session for this user")
        session = session_value_or_refuse(user_id, row["session_string"])
        if session is None:
            raise RuntimeError("Telegram session is encrypted; this listener has no decryption key")
        await self.start_listener(user_id, session)
        listener = self.listeners.get(user_id)
        if not listener:
            raise RuntimeError("Failed to start listener")
        return await listener.list_channels()

    def get_status(self) -> list[dict[str, Any]]:
        return [
            {
                "user_id": s.user_id,
                "connected": s.connected,
                "last_event_at": int(s.last_event_at * 1000) if s.last_event_at else 0,
                "last_successful_poll_at": int(s.last_successful_poll_at * 1000)
                if s.last_successful_poll_at
                else 0,
                "monitored_channels": s.monitored_channels,
                "consecutive_probe_failures": s.consecutive_probe_failures,
            }
            for s in (l.get_status() for l in self.listeners.values())
        ]

    async def health_payload(self) -> dict[str, Any]:
        detail = self.get_status()
        now_ms = asyncio.get_event_loop().time() * 1000
        stale_ms = self.cfg.health_stale_ms
        ok = len(detail) == 0 or all(
            s["connected"]
            and (s["last_event_at"] == 0 or now_ms - s["last_event_at"] < stale_ms)
            for s in detail
        )
        from . import metrics

        leases = list_active_leases(self.supabase)
        return {
            "ok": ok,
            "role": self.cfg.worker_role,
            "shard": f"{self.cfg.shard_id}/{self.cfg.shard_count}",
            "instance": self.cfg.instance_id,
            "listeners": len(detail),
            "detail": detail,
            "active_leases": len(leases),
            "metrics": metrics.snapshot(),
            "checked_at": asyncio.get_event_loop().time(),
            "engine": "telethon",
        }

    async def disconnect_all(self) -> None:
        for uid in list(self.listeners.keys()):
            await self.stop_listener(uid)
