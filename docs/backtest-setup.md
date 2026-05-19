# Signal channel backtesting (Telegram-only)

Backtests replay parsed Telegram signals against historical OHLC bars from [Massive.com](https://massive.com/docs/rest/quickstart) (Polygon-compatible REST API).

## Flow

1. **UI** — pick one signal channel, date range → **Backtest**
2. **Edge** (`backtest-run`) — creates a run, calls the worker once per channel (Telegram sync with live progress on the run)
3. **Worker** (`POST /auth/backtest_sync_signals`) — fetches Telegram history, calls `parse-signal` in `parse_only` mode, upserts `backtest_channel_signals`
4. **Edge** — loads signals, fetches Massive bars per symbol, simulates TP/SL (pips + duration per signal), writes trades and summary (`totalPips`)

No preview import, no OpenAI, no symbol filter, no tick-quote mode in v1.

## Setup

### 1. Database

Apply migrations:

- `20260516150000_backtest.sql` — runs, trades, equity
- `20260516180000_backtest_channel_signals.sql` — dedicated signal store + `upsert_backtest_channel_signal` RPC

```bash
supabase db push
```

**Tables:**

- `signals` — live copier log (unchanged by backtest)
- `backtest_channel_signals` — normalized buy/sell rows for simulation

Each tradeable row needs **buy/sell**, a **valid symbol**, and **SL or TP**. Entry may be omitted (`entry_price = 0` = market at signal time).

### 2. Worker

The worker must be running with:

- Active `telegram_sessions` for the user
- Channel in `telegram_channels` with `is_active = true`
- `PARSE_SIGNAL_URL` (or `SUPABASE_URL` + `/functions/v1/parse-signal`)
- `SUPABASE_SERVICE_ROLE_KEY` for parse auth and RPC upsert

Optional env on worker:
- `BACKTEST_PARSE_CONCURRENCY` (default `4`) — parallel parse-signal calls
- `BACKTEST_PARSE_DELAY_MS` (default `0`) — pause between parses (raise if parse-signal rate-limits)
- `BACKTEST_FETCH_ALL_MESSAGES=true` — scan every Telegram text message (slow); default filters to trade-like messages only

Deploy/restart the worker after pulling changes (new route `POST /auth/backtest_sync_signals`).

### 3. Supabase Edge secrets

| Secret | Purpose |
|--------|---------|
| `MASSIVE_API_KEY` (or `POLYGON_API_KEY`) | Market data |
| `MASSIVE_CALLS_PER_MINUTE` | Default `5` — rate limit spacing (raise if your plan allows) |
| `WORKER_URL` | Base URL of the worker (no trailing slash) |
| `WORKER_INTERNAL_TOKEN` | Must match worker env |

### 4. Deploy edge functions

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy backtest-run
supabase functions deploy parse-signal
```

`backtest-run` validates the user JWT in code (`verify_jwt = false` in config for OPTIONS/CORS).

### 5. App

Open **Backtest** in the sidebar (`/backtest`).

## Deploy checklist

1. `supabase db push` (if migrations pending)
2. Deploy **worker** (includes `/auth/backtest_sync_signals`)
3. Deploy **`backtest-run`** and **`parse-signal`**
4. Confirm Edge secrets: `MASSIVE_API_KEY`, `WORKER_URL`, `WORKER_INTERNAL_TOKEN`

## Troubleshooting

| Symptom | Check |
|---------|--------|
| `0 messages from Telegram` | User session active; channel access; worker online |
| `WORKER_URL not configured` | Edge secret set to reachable worker URL |
| `MASSIVE_API_KEY not configured` | Edge secret (not only worker `.env`) |
| Some trades `no_data` | Rate limit — increase plan or `MASSIVE_CALLS_PER_MINUTE`; run continues |
| Fewer signals than expected | Only tradeable messages stored; Telegram pagination cap ~1000 messages per sync |

## Limits (v1)

- Telegram history: newest→oldest pagination, **~1000 messages** per channel sync
- OHLC bars only (5m default for 30-day ranges; auto-coarsens for longer ranges)
- Telegram sync on run only when no signals exist in range; use **Sync signals only** to refresh
- Fixed lot sizing; breakeven after TP1 (built-in strategy)
- Latest run persisted in browser `localStorage` for refresh

## Out of scope

- Copier log sync, CSV upload, multi-run history sidebar
- Tick quotes, risk-% sizing, per-symbol filter, lenient/OpenAI parse
