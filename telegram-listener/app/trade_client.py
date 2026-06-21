"""HTTP client for trade worker parse + dispatch."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from .config import Config


class TradeClient:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._token = cfg.worker_internal_token

    def _trade_url(self) -> str:
        return self.cfg.trade_worker_url or self.cfg.trade_mgmt_worker_url

    async def parse_modification(
        self,
        *,
        channel_row_id: str,
        raw_message: str,
        user_id: str,
        is_reply: bool = False,
        parent_signal_id: str | None = None,
        revision: dict[str, Any] | None = None,
        force_ai: bool = False,
    ) -> dict[str, Any]:
        base = self._trade_url()
        if not base:
            raise RuntimeError("TRADE_WORKER_URL not configured")
        url = f"{base}/internal/parse-modification"
        timeout = max(self.cfg.trade_signal_push_timeout_ms / 1000, 4.0)
        body: dict[str, Any] = {
            "channel_row_id": channel_row_id,
            "raw_message": raw_message,
            "user_id": user_id,
            "is_reply": is_reply,
            "parent_signal_id": parent_signal_id,
            "force_ai": force_ai,
        }
        if revision:
            body["revision"] = revision
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(
                url,
                headers={"x-internal-token": self._token, "Content-Type": "application/json"},
                json=body,
            )
            res.raise_for_status()
            return res.json()

    async def reconcile_signals(
        self, *, user_id: str, channel_row_id: str | None = None
    ) -> dict[str, Any]:
        base = self._trade_url()
        if not base:
            raise RuntimeError("TRADE_WORKER_URL not configured")
        url = f"{base}/internal/reconcile-signals"
        timeout = max(self.cfg.trade_signal_push_timeout_ms / 1000, 8.0)
        body: dict[str, Any] = {"user_id": user_id}
        if channel_row_id:
            body["channel_row_id"] = channel_row_id
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(
                url,
                headers={"x-internal-token": self._token, "Content-Type": "application/json"},
                json=body,
            )
            res.raise_for_status()
            return res.json()

    async def parse_signal(
        self, *, channel_row_id: str, raw_message: str, user_id: str
    ) -> dict[str, Any]:
        base = self._trade_url()
        if not base:
            raise RuntimeError("TRADE_WORKER_URL not configured")
        url = f"{base}/internal/parse-signal"
        timeout = self.cfg.trade_signal_push_timeout_ms / 1000
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(
                url,
                headers={"x-internal-token": self._token, "Content-Type": "application/json"},
                json={
                    "channel_row_id": channel_row_id,
                    "raw_message": raw_message,
                    "user_id": user_id,
                },
            )
            res.raise_for_status()
            return res.json()

    async def dispatch_signal(self, signal: dict[str, Any], *, source: str = "telethon_listener") -> bool:
        base = self._trade_url()
        if not base:
            raise RuntimeError("TRADE_WORKER_URL not configured")
        url = f"{base}/internal/dispatch-signal"
        timeout = self.cfg.trade_signal_push_timeout_ms / 1000
        body = {"signal": signal, "source": source, "await": True}

        for attempt in range(1, self.cfg.trade_signal_push_max_attempts + 1):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    res = await client.post(
                        url,
                        headers={"x-internal-token": self._token, "Content-Type": "application/json"},
                        json=body,
                    )
                    if res.status_code < 500:
                        data = res.json()
                        return bool(data.get("accepted"))
            except Exception as exc:
                print(f"[trade_client] dispatch attempt {attempt} failed: {exc}")
            if attempt < self.cfg.trade_signal_push_max_attempts:
                await asyncio.sleep(0.075 * attempt)
        return False
