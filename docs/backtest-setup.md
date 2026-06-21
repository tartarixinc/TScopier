# Signal channel backtesting (Telegram-only)

Backtests replay parsed Telegram signals against historical market data from your **linked FxSocket MT5 broker**. New runs use **tick-level simulation** via `GET /QuoteTicks` when available, with M1 OHLC bar fallback (`GET /PriceHistory`).

## Flow

1. **UI** — pick one signal channel, date range → **Backtest**
2. **Edge** (`backtest-run`) — creates a run, calls the worker once per channel (Telegram sync with live progress on the run)
3. **Worker** (`POST /auth/backtest_sync_signals`) — fetches Telegram history, calls `parse-signal` in `parse_only` mode, upserts `backtest_channel_signals`
4. **Edge** — loads signals, fetches FXsocket quote ticks (or OHLC bars as fallback) per symbol via the user's linked broker, simulates TP/SL (pips + duration per signal), writes trades and summary (`totalPips`)
5. **Result modal** — on demand, `action: trade_replay` fetches ticks for the trade window and returns aggregated candles for the price replay chart

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

**Telegram and backtest on the same worker:** Backtest signal sync briefly pauses the live copier listener (MTProto allows only one connection per session). The worker restarts the listener when sync finishes. If Telegram looks disconnected after a backtest, wait ~30s and refresh Copier Engine, or use **Reconnect Telegram**.

**Recommended:** Set Supabase edge secret `BACKTEST_WORKER_URL` to a dedicated `WORKER_ROLE=backtest` service so backtests never pause the live listener on your copier worker.

Optional env on worker:
- `BACKTEST_PARSE_CONCURRENCY` (default `4`) — parallel parse-signal calls
- `BACKTEST_PARSE_DELAY_MS` (default `0`) — pause between parses (raise if parse-signal rate-limits)
- `BACKTEST_FETCH_ALL_MESSAGES=true` — scan every Telegram text message (slow); default filters to trade-like messages only

Deploy/restart the worker after pulling changes (new route `POST /auth/backtest_sync_signals`).

### 3. Supabase Edge secrets

| Secret | Purpose |
|--------|---------|
| `FXSOCKET_API_KEY` | FxSocket platform key — market data + broker API |
| `WORKER_URL` | Base URL of the worker (no trailing slash) |
| `WORKER_INTERNAL_TOKEN` | Must match worker env |

### 4. Linked broker (required)

Each user must have at least one **active MT5 broker** linked in **Brokers** (`broker_accounts.fxsocket_account_id`). Backtests fetch OHLC history from that broker's terminal — symbol names must exist in the broker's Market Watch (e.g. `XAUUSD.r`).

### 5. Deploy edge functions

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy backtest-run
supabase functions deploy parse-signal
```

`backtest-run` validates the user JWT in code (`verify_jwt = false` in config for OPTIONS/CORS).

### 6. App

Open **Backtest** in the sidebar (`/backtest`).

## Deploy checklist

1. `supabase db push` (if migrations pending)
2. Deploy **worker** (includes `/auth/backtest_sync_signals`)
3. Deploy **`backtest-run`** and **`parse-signal`**
4. Confirm Edge secrets: `FXSOCKET_API_KEY`, `WORKER_URL`, `WORKER_INTERNAL_TOKEN`
5. User has a connected broker in **Brokers**

## Troubleshooting

| Symptom | Check |
|---------|--------|
| `0 messages from Telegram` | User session active; channel access; worker online |
| `WORKER_URL not configured` | Edge secret set to reachable worker URL |
| `FXSOCKET_API_KEY not configured` | Edge secret (not only worker `.env`) |
| `Connect an MT5 broker in Brokers` | User needs linked FxSocket broker account |
| Some trades `no_data` | Symbol not on broker `/symbols`; or broker history unavailable for date range |
| Fewer signals than expected | Only tradeable messages stored; Telegram pagination cap ~1000 messages per sync |

## Limits (v1)

- Telegram history: newest→oldest pagination, **~1000 messages** per channel sync
- Tick simulation by default (M1 bar fallback when QuoteTicks unavailable)
- Telegram sync on run only when no signals exist in range; use **Sync signals only** to refresh
- Fixed lot sizing; breakeven after TP1 (built-in strategy)
- Latest run persisted in browser `localStorage` for refresh
- Market data scoped to user's linked broker (not global third-party feed)
- Trade replay chart loads on demand when opening a result (not stored in DB)

## Out of scope

- Copier log sync, CSV upload, multi-run history sidebar
- Risk-% sizing, per-symbol filter, lenient/OpenAI parse
- Re-running old minute-bar runs automatically in tick mode
