-- Record the actual close price on each closed trade. The worker has
-- always known the exit level (broker order history carries it) but never
-- stored it, so the dashboard could only re-read the broker live. One
-- writer (closedTradeClosePriceMonitor) backfills this column for every
-- close path, including trades closed before this column existed.

alter table public.trades
  add column if not exists close_price numeric(20,8);

comment on column public.trades.close_price is
  'Price the position was closed at, copied from broker order history. Null until backfilled; the broker did not report one.';

-- Supports the monitor probe: closed trades still missing their close
-- price, with a broker ticket to look the fill up by.
create index if not exists trades_missing_close_price_idx
  on public.trades (closed_at desc)
  where status = 'closed'
    and close_price is null
    and metaapi_order_id is not null;
