"""FastAPI entry — mirrors TS listener HTTP routes."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from .auth_service import AuthService
from .config import Config
from .session_manager import SessionManager


cfg = Config.load()
session_manager = SessionManager(cfg)
auth_service = AuthService(cfg, session_manager.supabase, session_manager)
_background_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not cfg.supabase_url or not cfg.worker_internal_token:
        raise RuntimeError("SUPABASE_URL and WORKER_INTERNAL_TOKEN required")
    await session_manager.load_all()

    async def renew_loop() -> None:
        while True:
            await asyncio.sleep(cfg.lease_renew_interval_ms / 1000)
            await session_manager.renew_all_leases()

    async def sync_loop() -> None:
        while True:
            await asyncio.sleep(30)
            await session_manager.sync_sessions()

    _background_tasks.append(asyncio.create_task(renew_loop()))
    _background_tasks.append(asyncio.create_task(sync_loop()))
    yield
    for t in _background_tasks:
        t.cancel()
    await session_manager.disconnect_all()


app = FastAPI(title="TScopier Telethon Listener", lifespan=lifespan)


def _check_token(token: str | None) -> None:
    if token != cfg.worker_internal_token:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
async def health() -> JSONResponse:
    payload = await session_manager.health_payload()
    status = 200 if payload.get("ok") else 503
    return JSONResponse(content=payload, status_code=status)


@app.post("/auth/send_code")
async def send_code(
    request: Request, x_internal_token: str | None = Header(default=None)
) -> dict[str, str]:
    _check_token(x_internal_token)
    body = await request.json()
    user_id = str(body.get("user_id") or "")
    phone = str(body.get("phone") or "")
    if not user_id or not phone:
        raise HTTPException(status_code=400, detail="user_id and phone required")
    return await auth_service.send_code(user_id, phone)


@app.post("/auth/verify_code")
async def verify_code(
    request: Request, x_internal_token: str | None = Header(default=None)
) -> dict[str, Any]:
    _check_token(x_internal_token)
    body = await request.json()
    user_id = str(body.get("user_id") or "")
    phone = str(body.get("phone") or "")
    code = str(body.get("code") or "")
    password = body.get("password")
    if not user_id or not phone or not code:
        raise HTTPException(status_code=400, detail="user_id, phone, code required")
    try:
        result = await auth_service.verify_code(
            user_id, phone, code, str(password) if password else None
        )
        if result.get("requires_password"):
            return {"requires_password": True}
        return result
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/auth/list_channels")
async def list_channels(
    request: Request, x_internal_token: str | None = Header(default=None)
) -> dict[str, Any]:
    _check_token(x_internal_token)
    body = await request.json()
    user_id = str(body.get("user_id") or "")
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id required")
    channels = await session_manager.list_channels(user_id)
    return {"channels": channels}
