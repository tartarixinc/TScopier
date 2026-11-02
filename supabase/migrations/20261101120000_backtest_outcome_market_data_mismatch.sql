-- 2026-11-01: allow the new market_data_mismatch outcome.
-- A simulated trade whose market price disagrees with every level the signal
-- carries (wrong instrument resolved, e.g. BTCAUDm for BTCUSD) is recorded
-- with this outcome; without it the backtest-run insert fails the CHECK
-- constraint on every affected row and the whole run errors out.
-- Verified 2026-11-01: both staging and prod still carry the 8-value check.

ALTER TABLE backtest_trades DROP CONSTRAINT IF EXISTS backtest_trades_outcome_check;
ALTER TABLE backtest_trades ADD CONSTRAINT backtest_trades_outcome_check CHECK (
  outcome IN (
    'open', 'sl_before_tp', 'tp1_then_sl', 'tp_then_be', 'all_tp_hit',
    'breakeven', 'no_data', 'skipped', 'market_data_mismatch'
  )
);

-- Register the migration (filename stem as name, matching repo convention) so
-- scripts/check-migrations.py stays green after a dashboard paste of this file.
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261101120000', '20261101120000_backtest_outcome_market_data_mismatch')
ON CONFLICT (version) DO NOTHING;
