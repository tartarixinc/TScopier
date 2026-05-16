# Signal channel backtesting

Backtests replay parsed Telegram signals against historical market data from [Massive.com](https://massive.com/docs/rest/quickstart) (Polygon-compatible REST API).

## Setup

1. Create a Massive API key and add to **Supabase Edge secrets**:
   - `MASSIVE_API_KEY` (or legacy `POLYGON_API_KEY`)
   - Optional: `MASSIVE_API_BASE_URL` (default `https://api.massive.com`)

2. Apply migration `20260516150000_backtest.sql`.

3. Link the project (once) and deploy the edge function:
   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy backtest-run
   ```
   `supabase/config.toml` sets `verify_jwt = false` for `backtest-run` so browser preflight (OPTIONS) succeeds; the function still validates the user JWT in code.

   If the UI shows a CORS error on `backtest-run`, the function is usually missing or not deployed to the same project as `VITE_SUPABASE_URL`.

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
