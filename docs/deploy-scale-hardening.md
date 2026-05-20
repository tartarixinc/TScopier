# Deploy checklist — observability + scale hardening

Run after merging scale-readiness changes.

## Worker (listener + trade entry)

1. Redeploy **listener** and **trade entry** from latest `main`.
2. Confirm listener env:
   - `TRADE_SIGNAL_PUSH_ENABLED=true`
   - `TRADE_WORKER_URL` or `TRADE_WORKER_SHARD_URLS` + `TRADE_WORKER_SHARD_COUNT`
   - `TRADE_SIGNAL_PUSH_MAX_ATTEMPTS=3` (optional, default)
3. Confirm trade entry env:
   - `MT4API_HTTP_CONNECTIONS=128` (or higher under load test)
   - `WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES=true`
4. Listener startup must **not** log `FATAL: TRADE_WORKER_SHARD_URLS` mismatch.

## Frontend

1. Redeploy web app for Copier Engine warning + Connect all brokers + Account Config save warning.

## Verify

1. Post one test signal per user — check Channel Worker for `pipeline_summary` or `order_send`.
2. Misconfigured broker (empty channels) — should show `dispatch_skipped` with `no_broker_channel_match`.
3. Run [`scripts/diagnostics/pipeline_latency.sql`](../diagnostics/pipeline_latency.sql) in Supabase.

## Staging shard pilot

Follow [`docs/staging-shard-fleet.md`](../docs/staging-shard-fleet.md) with `WORKER_SHARD_COUNT=4` before production fleet expansion.
