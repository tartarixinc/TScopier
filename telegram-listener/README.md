# Telethon listener (Python)

Replaces the gramjs `UserListener` for users with `telegram_sessions.listener_engine = 'telethon'`.

## Deploy (Railway)

- **Root directory:** `telegram-listener`
- **Replicas:** 1 per shard (never scale horizontally — one MTProto session per user)
- **Env:** same as TS listener plus:

```env
WORKER_ROLE=listener
LISTENER_ENGINE=telethon
TRADE_WORKER_URL=https://your-trade-worker.up.railway.app
WORKER_INTERNAL_TOKEN=<shared with trade>
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
```

Point Supabase Edge `TELEGRAM_LISTENER_URL` (or `WORKER_URL`) at this service for auth.

## Cutover

1. Deploy this service
2. `UPDATE telegram_sessions SET listener_engine = 'telethon' WHERE user_id = '...'`
3. Restart gramjs listener shard (user dropped) and verify Telethon picks up session
4. Post test signal — expect Copier Logs row within 30s (poll backstop)

## Signal channels registry (channel-scoped listener)

When `CHANNEL_LISTENER_MODE` is `shadow` or `primary`, align Telethon ingest with the TS worker protocol:

- Upsert `signal_channels` by canonical `telegram_chat_id` (`-100…` form)
- Link `telegram_channels.signal_channel_id` on subscription
- Acquire `channel_listener_leases` for elected subscriber session (`acquire_channel_listener_lease` RPC)
- Write `channel_messages` + `channel_signals` keyed by `signal_channels.id`
- Honor `CHANNEL_LISTENER_ALLOWLIST` and auto-enroll threshold (`CHANNEL_LISTENER_AUTO_ENROLL_MIN`, default 3)
- In `primary` mode: passive subscribers skip poll/reconcile when canonical feed is live

See `worker/src/channelListenerManager.ts` (`TELETHON_CHANNEL_LISTENER_NOTES`) for the full contract.

## Local

```bash
cd telegram-listener
pip install -r requirements.txt
export $(grep -v '^#' ../worker/.env | xargs)  # or set vars manually
uvicorn app.main:app --reload --port 8080
```
