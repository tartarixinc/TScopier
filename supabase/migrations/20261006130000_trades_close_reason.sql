/*
  # Trades — close_reason column

  DEPLOY ORDER: apply this migration BEFORE promoting any worker build that
  contains `worker/src/tradeCloseUpdate.ts`-style close writes. The Management
  API is read-only (25006), so this file is run by hand in the dashboard while
  Railway deploys the worker on push. If the column is missing the worker
  still closes the trade (it retries the update without the reason and warns
  in the log), but the reason for that window is lost.

  Hand-applied migrations must also be registered so later runs know they
  happened (`name` is the file name without .sql, matching the convention
  already used in that table):
    INSERT INTO supabase_migrations.schema_migrations (version, name)
    VALUES ('20261006130000', '20261006130000_trades_close_reason')
    ON CONFLICT (version) DO NOTHING;

  Records why a trade reached `status = 'closed'`. The worker sets it at the
  moment it writes the terminal status (news pre-close, opposite signal,
  signal close, copy-limit flatten, position gone, ...). When the broker
  closes a position on its own (stop loss / take profit) the worker never
  sees the event, so the column stays NULL and the frontend falls back to
  comparing `close_price` with `sl` / `tp`.

  Codes written: news_pre_close, signal_close, signal_revision, opposite_signal,
  partial_tp, auto_management, close_worse_entries, copy_limit_flatten,
  user_force_close, position_gone. Copy-limit flatten and force-close also
  write it on pending rows, whose terminal status is `cancelled`; the trade
  modal only shows a reason for `closed` rows.

  Backwards compatible: nullable column, no default, existing rows untouched.
*/

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS close_reason text;

COMMENT ON COLUMN trades.close_reason IS
  'Why the trade was closed: news_pre_close, signal_close, signal_revision, opposite_signal, partial_tp, auto_management, close_worse_entries, copy_limit_flatten, user_force_close, position_gone. NULL = written by the broker (SL/TP) or predates this column.';
