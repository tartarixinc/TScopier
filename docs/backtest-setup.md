# Signal channel backtesting

Backtests replay parsed Telegram signals against historical market data from [Massive.com](https://massive.com/docs/rest/quickstart) (Polygon-compatible REST API).

## Setup

1. Create a Massive API key and add to **Supabase Edge secrets**:
   - `MASSIVE_API_KEY` (or legacy `POLYGON_API_KEY`)
   - Optional: `MASSIVE_API_BASE_URL` (default `https://api.massive.com`)

2. Apply migration `20260516150000_backtest.sql`.

3. Deploy edge function:
   ```bash
   supabase functions deploy backtest-run
   ```

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
