# Load test harness

Repeatable scripts to measure copy latency and derive shard sizing for ~10k users.

## Prerequisites

- Trade entry worker running with `WORKER_INTERNAL_TOKEN` set
- Staging or isolated environment (do not run burst against production brokers)

## burst-dispatch.mjs

Synthetic `POST /internal/dispatch-signal` load against a trade-entry shard.

```bash
cd scripts/load

export TRADE_WORKER_URL=https://your-trade-entry.up.railway.app
export WORKER_INTERNAL_TOKEN=your-secret
export LOAD_USER_IDS=user-id-1,user-id-2,user-id-3   # comma-separated test users
export LOAD_SIGNAL_COUNT=100                          # default 100
export LOAD_CONCURRENCY=20                            # default 20 parallel

node burst-dispatch.mjs
```

Output: P50/P99 dispatch RTT (HTTP round-trip only; no real OrderSend unless users have live brokers).

## Burst scenario (500 signals / 10s)

```bash
LOAD_SIGNAL_COUNT=500 LOAD_CONCURRENCY=50 node burst-dispatch.mjs
```

Target: P99 HTTP dispatch &lt;500ms per shard before broker execution.

## Listener soak (manual)

1. Deploy listener shard with `WORKER_SHARD_COUNT=4` and N real or test sessions on that shard.
2. Monitor Railway metrics: memory, CPU, event-loop lag.
3. Query lease renew QPS:

```sql
select count(*) from worker_session_leases where role = 'listener';
```

4. `curl /health` — all listeners `connected: true`, fresh `last_event_at`.

## Fleet sizing (starting estimates)

| Scale | Listener shards | Trade-entry shards | Users/shard (listener) |
|-------|-----------------|--------------------|-------------------------|
| 100   | 1–2             | 1                  | ~50–100                 |
| 1,000 | 10–20           | 5–10               | ~50–100                 |
| 10,000| 70–200          | 20–50              | tune after load test    |

Adjust after `burst-dispatch.mjs` and pipeline SQL in [`../diagnostics/pipeline_latency.sql`](../diagnostics/pipeline_latency.sql).

## Pipeline latency SQL

Run after real test signals:

```bash
# Paste scripts/diagnostics/pipeline_latency.sql in Supabase SQL Editor
```

Alert if P99 `total_ms` &gt; 2000 or `dispatch_skipped` rate rises.
