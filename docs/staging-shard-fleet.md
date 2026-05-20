# Staging shard fleet (WORKER_SHARD_COUNT=4 pilot)

Pilot horizontal sharding before scaling to 10k users. Use **staging Supabase** and **staging Railway** services only.

## Architecture

```text
listener-shard-0..3  (WORKER_ROLE=listener, 1 replica each)
        │
        │ TRADE_WORKER_SHARD_URLS (4 URLs, ordered 0..3)
        ▼
trade-entry-shard-0..3  (WORKER_ROLE=trade_entry, 1 replica each)
trade-mgmt-shard-0..3   (WORKER_ROLE=trade_mgmt, optional)
```

User routing: `hash(user_id) % 4` on both listener and trade workers.

## Listener env (per shard)

Create 4 Railway services from the same worker image:

```env
WORKER_ROLE=listener
WORKER_SHARD_ID=0          # 0, 1, 2, or 3 per service
WORKER_SHARD_COUNT=4
WORKER_INTERNAL_TOKEN=<shared-secret>

TRADE_WORKER_SHARD_URLS=https://trade-entry-shard-0.up.railway.app,https://trade-entry-shard-1.up.railway.app,https://trade-entry-shard-2.up.railway.app,https://trade-entry-shard-3.up.railway.app
TRADE_WORKER_SHARD_COUNT=4
TRADE_MGMT_WORKER_URL=https://trade-mgmt-shard-0.up.railway.app

TRADE_SIGNAL_PUSH_ENABLED=true
TRADE_SIGNAL_PUSH_MAX_ATTEMPTS=3
TELEGRAM_SHUTDOWN_DRAIN_MS=8000
```

Startup validates `TRADE_WORKER_SHARD_URLS.length === TRADE_WORKER_SHARD_COUNT` — mismatch exits with FATAL.

## Trade entry env (per shard)

```env
WORKER_ROLE=trade_entry
WORKER_SHARD_ID=0          # match listener partition index
WORKER_SHARD_COUNT=4
WORKER_INTERNAL_TOKEN=<shared-secret>
WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES=true
EXECUTOR_REALTIME_SIGNALS=false
MT4API_HTTP_CONNECTIONS=128
```

## Trade management env (per shard, optional)

```env
WORKER_ROLE=trade_mgmt
WORKER_SHARD_ID=0
WORKER_SHARD_COUNT=4
WORKER_INTERNAL_TOKEN=<shared-secret>
EXECUTOR_REALTIME_SIGNALS=false
```

## Verification checklist

1. **Startup** — each listener shard logs no FATAL shard URL errors.
2. **Health** — `curl https://listener-shard-0/health` shows only users where `hash(user_id)%4==0`.
3. **Routing** — post test signal; listener logs show push to correct trade-entry URL index.
4. **Wrong shard** — dispatch to shard-0 with user on shard-2 returns `accepted: false, reason: wrong_shard`.
5. **Load** — run [`scripts/load/burst-dispatch.mjs`](../load/burst-dispatch.mjs) against each trade-entry URL.

## Scaling beyond 4

Increase `WORKER_SHARD_COUNT` on **all** listener and trade services together. Append new URLs to `TRADE_WORKER_SHARD_URLS` in shard-id order. Never run two replicas with the same `WORKER_SHARD_ID`.

See also [`worker-deployment.md`](worker-deployment.md) and [`scripts/load/README.md`](../load/README.md).
