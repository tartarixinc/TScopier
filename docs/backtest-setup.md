# Signal channel backtesting

Backtests replay parsed Telegram signals against historical market data from [Massive.com](https://massive.com/docs/rest/quickstart) (Polygon-compatible REST API).

## Setup

1. Create a Massive API key and add to **Supabase Edge secrets**:
   - `MASSIVE_API_KEY` (or legacy `POLYGON_API_KEY`)
   - Optional: `MASSIVE_API_BASE_URL` (default `https://api.massive.com`)

2. Apply migrations:
   - `20260516150000_backtest.sql` (runs, simulated trades, equity)
   - `20260516170000_channel_trade_signals.sql` (helper extract function)
   - `20260516180000_backtest_channel_signals.sql` (dedicated backtest signal store)

   If `20260516170000` failed with `null value in column "channel_id"`, run `20260516180000` after pulling the fix (it skips signals without `channel_id`).

   ```bash
   supabase db push
   ```

   **Signal storage:**
   - **`signals`** — live copier log (all Telegram messages).
   - **`backtest_channel_signals`** — normalized buy/sell rows used for backtests.

   When you run a backtest, the worker **fetches Telegram history** for your selected date range. Parsing uses `parse-signal` in **`parse_only` mode** (no writes to `signals`, no trade execution). Tradeable rows go only into `backtest_channel_signals`. Copier Logs are unaffected.

3. Link the project (once) and deploy the edge function:
   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy backtest-run
   ```
   `supabase/config.toml` sets `verify_jwt = false` for `backtest-run` so browser preflight (OPTIONS) succeeds; the function still validates the user JWT in code.

   Set **`MASSIVE_API_KEY`** in Supabase Edge secrets. Without it, runs fail before market data is fetched.

   If the UI shows a CORS error on `backtest-run`, the function is usually missing or not deployed to the same project as `VITE_SUPABASE_URL`.

   If **no Massive API calls** appear: the run had **zero tradeable signals** in the date range (check the signal preview on the Backtest page). Massive is only called once there is at least one buy/sell signal with entry + SL or TP.

4. Open **Backtest** in the app sidebar (`/backtest`).

## Features

- Multi-channel portfolio backtests
- Tick quotes (forex BBO) or OHLC bar execution
- Breakeven after TP1/TP2/TP3
- Fixed lot or risk-% sizing
- Outcomes: TP1→SL, TP1→BE, all TPs, etc.
- Equity curve and channel leaderboard

## Frontend flag

Set `VITE_BACKTEST_ENABLED=false` to hide the preview badge only (feature remains available).
