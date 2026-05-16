-- Signal channel backtesting (Massive.com market data + simulated outcomes)

CREATE TABLE IF NOT EXISTS backtest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  progress_pct numeric(5,2) NOT NULL DEFAULT 0,
  progress_message text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtest_run_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES telegram_channels(id) ON DELETE CASCADE,
  UNIQUE (run_id, channel_id)
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  signal_id uuid REFERENCES signals(id) ON DELETE SET NULL,
  channel_id uuid REFERENCES telegram_channels(id) ON DELETE SET NULL,
  symbol text NOT NULL DEFAULT '',
  direction text NOT NULL CHECK (direction IN ('buy', 'sell')),
  signal_at timestamptz NOT NULL,
  entry_price numeric(18,8) NOT NULL,
  sl numeric(18,8),
  tp_levels numeric(18,8)[] NOT NULL DEFAULT '{}',
  lot_size numeric(12,4) NOT NULL DEFAULT 0.01,
  outcome text NOT NULL DEFAULT 'open'
    CHECK (outcome IN (
      'open', 'sl_before_tp', 'tp1_then_sl', 'tp_then_be', 'all_tp_hit',
      'breakeven', 'no_data', 'skipped'
    )),
  tps_hit integer NOT NULL DEFAULT 0,
  exit_price numeric(18,8),
  closed_at timestamptz,
  pnl numeric(18,4) NOT NULL DEFAULT 0,
  pnl_r numeric(12,4),
  max_favorable_excursion numeric(18,8),
  max_adverse_excursion numeric(18,8),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(run_id);
CREATE INDEX IF NOT EXISTS idx_backtest_trades_signal ON backtest_trades(signal_id);

CREATE TABLE IF NOT EXISTS backtest_equity_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  equity numeric(18,4) NOT NULL,
  balance numeric(18,4) NOT NULL,
  drawdown_pct numeric(8,4) NOT NULL DEFAULT 0,
  open_trades integer NOT NULL DEFAULT 0,
  UNIQUE (run_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_backtest_equity_run_ts ON backtest_equity_points(run_id, ts);

ALTER TABLE backtest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_run_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_equity_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY backtest_runs_user ON backtest_runs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY backtest_run_channels_user ON backtest_run_channels
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM backtest_runs r
      WHERE r.id = run_id AND r.user_id = auth.uid()
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM backtest_runs r
      WHERE r.id = run_id AND r.user_id = auth.uid()
    )
  );

CREATE POLICY backtest_trades_user ON backtest_trades
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM backtest_runs r
      WHERE r.id = run_id AND r.user_id = auth.uid()
    )
  );

CREATE POLICY backtest_equity_user ON backtest_equity_points
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM backtest_runs r
      WHERE r.id = run_id AND r.user_id = auth.uid()
    )
  );

-- Realtime publication for run status updates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'backtest_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE backtest_runs;
  END IF;
END $$;
