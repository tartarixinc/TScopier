-- Connection-status transitions are recorded for every provider, so the
-- provider column has to accept every provider `broker_accounts` accepts.
--
-- `broker_connection_events_trigger()` inserts
-- `COALESCE(NEW.provider, 'fxsocket')` on every `connection_status` change,
-- and inserts the provider again for `mtapi_status` changes. With only
-- ('fxsocket', 'mtapi') allowed, any status transition on a cTrader, DXtrade,
-- TradeLocker, MatchTrader or crypto account failed the whole `broker_accounts`
-- update with a CHECK violation — the account could never move between
-- connected / error / disconnected once linked. No transition has happened on
-- such an account yet (verified: the table holds mtapi rows only), which is why
-- the defect has stayed latent.
--
-- `field` keeps its own two-value check: it names the column that changed and
-- the trigger only ever writes those two.

alter table public.broker_connection_events
  drop constraint if exists broker_connection_events_provider_check;

alter table public.broker_connection_events
  add constraint broker_connection_events_provider_check
    check (provider in ('fxsocket', 'mtapi', 'ctrader', 'binance', 'bybit', 'kucoin', 'dxtrade', 'tradelocker', 'matchtrader'));

comment on constraint broker_connection_events_provider_check on public.broker_connection_events is
  'Same provider list as broker_accounts_provider_check: every status transition the trigger records has to be storable.';

-- The comment above is informational; a comment on a constraint needs no extra
-- privilege beyond table ownership, and the migration runs as the project owner.
