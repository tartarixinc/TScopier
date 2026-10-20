/*
  # Trades — broker_position_ticket column

  DEPLOY ORDER: apply this migration BEFORE promoting any worker build that
  writes `trades.broker_position_ticket`. The Management API is read-only
  (25006), so this file is run by hand in the dashboard while Railway deploys
  the worker on push.

  On MT5 the ticket returned by an order send and the ticket that identifies
  the resulting live position are different numbers. `metaapi_order_id` keeps
  the value the send returned (used for order operations). This new column
  records the position identity resolved from a broker read taken right after
  the fill, which is what position lookups, break-even, reconciliation and
  the close paths should match on. It is only written when the resolution is
  certain; a guessed value is never stored.

  Hand-applied migrations must also be registered (`name` is the file name
  without .sql, matching the convention already used in that table):
    INSERT INTO supabase_migrations.schema_migrations (version, name)
    VALUES ('20261006140000', '20261006140000_trades_broker_position_ticket')
    ON CONFLICT (version) DO NOTHING;

  Backwards compatible: nullable text column, no default, existing rows
  untouched. Readers fall back to `metaapi_order_id` when it is null.
*/

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS broker_position_ticket text;

COMMENT ON COLUMN trades.broker_position_ticket IS
  'Broker position identity (MT5 position ticket) resolved from a read taken immediately after the fill. Null = not yet resolved or predates this column. Readers fall back to metaapi_order_id. Never guessed.';
