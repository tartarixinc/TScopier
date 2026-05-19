# Worker deployment (Railway / Docker)

## Hard rule: one MTProto connection per Telegram session

Telegram allows **exactly one** active connection per `telegram_sessions` auth key. Running two replicas (or overlapping deploys) with the same session causes `AUTH_KEY_DUPLICATED`, message gaps, and missed copier trades.

| Service type | Replicas | Scale lever |
|--------------|----------|-------------|
| `listener-shard-*` | **1** per shard | Add shard services (`WORKER_SHARD_ID` / `WORKER_SHARD_COUNT`) |
| `trade-worker` / `trade-entry` | 2–N | Horizontal replicas (no Telegram client) |
| `trade-mgmt` | 1–N | Management + reconcile monitors |
| `backtest-worker` | 0–2 | Bursty history sync only |
| Monolith (`WORKER_ROLE=all`) | **1** | Early commercial only |

## Railway services (recommended split)

Use the **same Docker image** with different env per service:

### 1. Listener (`WORKER_ROLE=listener`)

```env
WORKER_ROLE=listener
WORKER_SHARD_ID=0
WORKER_SHARD_COUNT=1
WORKER_INTERNAL_TOKEN=<same secret as trade workers>
TRADE_WORKER_URL=https://your-trade-entry.up.railway.app
TRADE_MGMT_WORKER_URL=https://your-trade-mgmt.up.railway.app
TELEGRAM_SHUTDOWN_DRAIN_MS=8000
WORKER_HEALTH_STALE_MS=180000
WORKER_LEASE_RENEW_INTERVAL_MS=20000
WORKER_SESSION_LEASE_TTL_MS=45000
```

- **Replicas:** min=1, max=1 (never scale this service horizontally for the same shard).
- **Health check:** `GET /health` on `WORKER_PORT` (default 8080).
- **Does not** run trade monitors or backtest sync on the live client.
- After `parse-signal`, pushes parsed rows to trade workers via `POST /internal/dispatch-signal` (Realtime remains fallback).

### 2. Trade entry (`WORKER_ROLE=trade_entry`) — recommended for latency

```env
WORKER_ROLE=trade_entry
WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES=true
WORKER_INTERNAL_TOKEN=<shared secret>
```

- **Replicas:** 2+ as needed.
- Executes **buy/sell** only; high-priority queue drains before management backlog.
- Monitors: virtual pending, CWE close, partial TP, signal entry pending.
- **Health:** `GET /health`; **dispatch:** `POST /internal/dispatch-signal` with `x-internal-token`.

### 3. Trade management (`WORKER_ROLE=trade_mgmt`) — optional split

```env
WORKER_ROLE=trade_mgmt
WORKER_INTERNAL_TOKEN=<shared secret>
```

- Handles **close / modify / breakeven / close worse entries**, etc.
- Monitors: basket SL/TP reconcile, auto-management, trailing stop, news filter, broker connection.

### 4. Trade combined (`WORKER_ROLE=trade`)

```env
WORKER_ROLE=trade
WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES=true
```

- Same as running `trade_entry` + `trade_mgmt` in one process (all monitors, all actions).
- Use when you do not want a separate management fleet yet.

### 5. Backtest (`WORKER_ROLE=backtest`)

```env
WORKER_ROLE=backtest
```

- Point Supabase Edge `BACKTEST_WORKER_URL` at this service (falls back to `WORKER_URL`).
- Ephemeral Telegram client per sync; never shares the listener connection.

### Monolith (default)

```env
WORKER_ROLE=all
```

Single replica on Railway until you split services.

## Deploy overlap

On deploy, old and new containers may briefly share an auth key. Mitigations:

1. `TELEGRAM_SHUTDOWN_DRAIN_MS=8000` (or higher) on SIGTERM before exit.
2. Railway: single replica per listener shard; avoid blue/green with two live listeners.
3. Monitor `/health` → `detail[].last_event_at` per user.

## Health endpoint

`GET /health` (no auth) returns:

- `ok` — all listeners connected and `last_event_at` within `WORKER_HEALTH_STALE_MS` (default 180s).
- `role`, `shard`, `instance`, `metrics`, `active_leases`.

Use external uptime checks on this URL for production paging.

## Sharding

Assign users with `shard = hash(user_id) % WORKER_SHARD_COUNT`. Each listener service sets `WORKER_SHARD_ID` to its index (0 … N-1).

Apply migration `20260520120000_worker_session_leases.sql` before enabling split deploys.

## Low-latency path (split deploy)

1. **Listener → trade HTTP push** — After `parse-signal`, the listener `POST`s to `TRADE_WORKER_URL` (entries) or `TRADE_MGMT_WORKER_URL` (management). This avoids waiting for Supabase Realtime (~100ms–several seconds).
2. **Entry fast path** — On `trade_entry` / `all`, live `buy`/`sell` dispatch calls `handleSignal` directly (no priority queue). Sweep, Realtime replay, and management still use the queue.
3. **Concurrent queue drain** — `EXECUTOR_MAX_CONCURRENT_SIGNALS` (default **4**) runs multiple queued signals in parallel so one slow management job does not block unrelated entries on a combined `trade` worker.
4. **Lease gate cache** — `WORKER_LEASE_GATE_CACHE_MS` (default **8000**) caches `isTelegramListenerLiveForUser` per user on trade workers to avoid a DB round-trip on every signal.
5. **Optional role split** — `trade_entry` vs `trade_mgmt` scales and isolates CPU; `trade` runs both.
6. **Monolith (`WORKER_ROLE=all`)** — Uses in-process `dispatchParsedSignal` (no HTTP push). Realtime + sweep remain fallbacks everywhere.

Broker `OrderSend` latency is unchanged; this stack removes ingest/dispatch delay before the first API call.

### Diagnosing slow execution

`trade_execution_logs` records pipeline stages per signal:

| `action` | Meaning |
|----------|---------|
| `dispatch_received` | HTTP push or in-process dispatch accepted |
| `handle_start` / `handle_end` | Trade worker began/finished `handleSignal` (`queue_wait_ms` on live path) |
| `order_send` | Broker `OrderSend` (see `request_payload.pipeline_ms`) |

Example for one signal (replace `<signal_id>`):

```sql
select action, status, request_payload, created_at
from trade_execution_logs
where signal_id = '<signal_id>'
order by created_at;
```

Look for a large gap between `handle_start` (`queue_wait_ms`) and the first successful `order_send`, or intentional delay from Copier Engine **`delay_msec`** on the channel.

### Range pending legs (duplicate opens)

The worker monitor (`virtualPendingMonitor`, 1.5s) is the primary firer; **`range-pending-sweep`** (Supabase cron, ~60s) only picks up rows the worker missed for 45s+.

Guards (worker + edge sweep):

- Do not fire a `step_idx` that already has a **`fired`** row for the same `(signal_id, broker_account_id, symbol)`.
- Do not insert a new pending row for a `step_idx` that already exists (any status) — the partial unique index only blocks duplicate **active** rows, so re-plans after fire used to create a second pending rung.
- Stale `claimed` rows are reconciled (re-fire only when no `virtual_pending_fired` log exists for that leg id).
- Open trades are capped using `virtual_pending_inserted.rows` + successful `order_send` count from execution logs.

If you already have runaway duplicates, cancel orphan actives (keep one `fired` row per step):

```sql
-- Pending/claimed rows where the same step already fired
update range_pending_legs dup
set status = 'cancelled', error_message = 'manual_duplicate_cleanup'
from range_pending_legs fired
where dup.status in ('pending', 'claimed')
  and fired.status = 'fired'
  and dup.signal_id = fired.signal_id
  and dup.broker_account_id = fired.broker_account_id
  and dup.symbol = fired.symbol
  and dup.step_idx = fired.step_idx
  and dup.id <> fired.id;
```

Redeploy **Trade Entry** and **`range-pending-sweep`** after guard changes.

## Channel management instructions (copier)

Management messages (`Close half`, `Close worse entries`, `Adjust SL`, etc.) are scoped as follows:

| Message type | Applies to |
|--------------|------------|
| **Reply** to a Telegram signal (`reply_to_message_id` set) | That signal’s basket only (e.g. Gold entry + SL/TP in the reply thread) |

**Close worse entries** (channel post) closes open legs on that channel whose entry is within your configured pip band of the live price, and always closes legs tagged with `cwe_close_price` (range multi-trade CWE immediates). Requires **Multi Trades** + **Close worse entries** enabled on the broker account. Redeploy **trade worker** and **parse-signal** after CWE fixes.

Channel **Adjust SL / TP** instructions are stored in `channel_active_trade_params` (per channel + symbol). They apply to **management**, **pending ladder legs**, and **parameter refresh** on open baskets — not to naked **buy/sell** posts with no SL/TP in the message (avoids stale levels → broker "Invalid stops"). Run migration `20260520130000_channel_active_trade_params.sql` when upgrading.

| **Channel post**, no symbol in text | All **open trades** on that Telegram channel |
| **Channel post** with symbol (`Close half on EURUSD`, `for gold`) | Open trades on that channel for that symbol only |
| **Modify SL/TP** with no symbol, multiple symbols open | Symbols where the price is plausible; if none match, the **most recently opened** symbol on the channel |

**Virtual range pendings** (`range_pending_legs`): management applies to pending ladder legs too — **Adjust SL/TP** updates their `stoploss` / `takeprofit` before they fire; **Close** deletes all pending legs in scope so they cannot trigger later.

Deploy **Trade worker** after logic changes; deploy **`parse-signal`** Edge if symbol parsing (`on` / `for`) changed.

## Environment reference

See `worker/.env.example` for catch-up, lease, and parse tuning variables.
