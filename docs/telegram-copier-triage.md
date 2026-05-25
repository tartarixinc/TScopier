# Telegram copier — Phase 0 triage runbook

Use this when signals reach Telegram but Copier Logs stay empty (listener failure) or rows appear without trades (trade layer).

## 1. Listener health

```bash
curl -sS "https://YOUR-LISTENER.up.railway.app/health" | jq .
```

Check:

- `ok` is `true`
- Each user in `detail[]` has `connected: true`
- `last_event_at` is within `WORKER_HEALTH_STALE_MS` (default 180s)
- `metrics.auth_key_duplicated` is 0 (or spike explains the gap)

## 2. Trade worker health

```bash
curl -sS "https://YOUR-TRADE.up.railway.app/health" | jq .
```

## 3. Split-deploy checklist

| Check | Listener env | Trade env |
|-------|--------------|-----------|
| Shared secret | `WORKER_INTERNAL_TOKEN` | same value |
| Shard | `WORKER_SHARD_ID`, `WORKER_SHARD_COUNT` | same values |
| Push target | `TRADE_WORKER_URL` set | `/internal/dispatch-signal` reachable |
| Lease gate | — | `WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES=true` requires fresh lease |

Test dispatch (replace values):

```bash
curl -sS -X POST "https://YOUR-TRADE.up.railway.app/internal/dispatch-signal" \
  -H "Content-Type: application/json" \
  -H "x-internal-token: YOUR_TOKEN" \
  -d '{"signal":{"id":"00000000-0000-4000-8000-000000000001","user_id":"USER_UUID","status":"parsed","parsed_data":{"action":"ignore"}},"source":"triage"}' | jq .
```

## 4. Supabase SQL

Run [`scripts/diagnostics/multi_user_channel_copy.sql`](../scripts/diagnostics/multi_user_channel_copy.sql) queries 1–12 in the SQL Editor after posting a test signal.

Interpretation:

| Query result | Likely gate |
|--------------|-------------|
| No session / inactive | User must reconnect Telegram |
| No lease or expired | Listener not running or lease renew failing |
| Invalid identity (query 7) | Re-add channel via Telegram picker |
| No signals (query 4) | Listener not ingesting — check worker logs |
| Signals but no execution logs | Trade push / broker whitelist / lease gate |

## 5. Listener logs (Railway)

After sending a test signal, grep for:

- `message candidate` — live event received
- `poll seeded` / `poll failed` — safety poll path
- `monitored message could not map` — channel ID mismatch
- `AUTH_KEY_DUPLICATED` — overlapping listener instances
- `dispatch signal` — parse succeeded, dispatch attempted

## 6. Diagnostic-only: disable lease gate

On **trade** worker only, temporarily set `WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES=false`. If trades resume, fix listener lease/connectivity before re-enabling.

## 7. Parse pipeline (Telethon → trade worker)

When channels show **Listening** but no trades:

1. Run SQL queries **#9–#12** in [`scripts/diagnostics/multi_user_channel_copy.sql`](../scripts/diagnostics/multi_user_channel_copy.sql)
2. Probe parse bridge:

```bash
TRADE_WORKER_URL=https://YOUR-TRADE.up.railway.app \
WORKER_INTERNAL_TOKEN=secret \
USER_ID=your-user-uuid \
CHANNEL_ROW_IDS=uuid1,uuid2 \
MESSAGE='BUY XAUUSD NOW SL 2650 TP 2700' \
./scripts/diagnostics/parse_pipeline_probe.sh
```

3. Replay parse locally with DB keywords:

```bash
./scripts/diagnostics/replay_channel_parse.sh \
  --channel-id CHANNEL_UUID \
  --message 'BUY XAUUSD NOW SL 2650 TP 2700'
```

(requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `worker/.env`)

| `signals.status` | `skip_reason` | Gate |
|--------------------|---------------|------|
| (no row) | — | Duplicate message, image-only, or Copier Logs filter |
| `skipped` | `non_trade_message` | Telethon heuristic (see `listener_events.heuristic_rejected`) |
| `skipped` | keyword message | `/internal/parse-signal` — tune `channel_keywords` |
| `error` | HTTP error text | `TRADE_WORKER_URL` / token / shard |
| `parsed` | — | Trade dispatch layer (broker whitelist, lease) |

Listener logs to grep: `heuristic_rejected`, `duplicate_message_skipped`, `parse_http_failed`, `image_only_message` in `listener_events` (query #12).

**Cross-channel message id collisions:** Telegram message ids are only unique per chat. If multiple channels stop ingesting while others work, run query **#13** and apply migration `20260525160000_signals_per_channel_message_unique.sql` (dedupe key is `user_id + channel_id + telegram_message_id`, not `user_id + telegram_message_id` alone). **Redeploy the Telethon listener** after the migration — the old listener still drops messages when another channel already used the same numeric message id.

**SIGNALS 2 missing but query #13 shows Signal Tester:** run query **#14** (ingest health) and **#15** (duplicate channel rows). Deactivate stale duplicates with [`prune_duplicate_telegram_channels.sql`](../scripts/diagnostics/prune_duplicate_telegram_channels.sql), then redeploy Telethon. Check query **#12** for `duplicate_message_skipped` or `signal_persist_failed` on the SIGNALS 2 `channel_row_id`.

## 8. Incident note template

```
Date:
User ID:
Channel:
Symptom: (no copier log / no trade / stale last_seen)

Listener /health: ok=?, last_event_at=?
Lease: valid=? expires_at=?
Signals row: yes/no, status=?
Execution logs: yes/no, skip_reason=?
Failing gate: listener_down | auth_key_dup | mapping | lease | trade_push | broker_whitelist
Action taken:
```
