-- Supports the fill monitor probe: closed trades that still miss either
-- their exit price or their realized profit, with a broker account and
-- ticket to look the fill up by.
--
-- The monitor filters on `or=(close_price.is.null,profit.is.null)`. Postgres
-- only uses a partial index when the query predicate implies the index
-- predicate, and an OR over two columns does not imply
-- `close_price is null`, so the existing `trades_missing_close_price_idx`
-- can no longer serve this query — both the idle probe and the batch select
-- would fall back to scanning and sorting every closed row. This index's
-- predicate is implied by the query, so the planner can walk it in
-- `closed_at desc` order, stop at the batch limit, and apply the
-- missing-column OR as a row filter. The `or=` clause is itself part of the
-- predicate (every disjunct of the query carries one of the two null tests),
-- so the index only holds rows that still need work: the idle probe's
-- `count: exact` walks missing rows instead of every closed trade in the
-- lookback window.
--
-- House style: plain `create index` (no `concurrently` anywhere in this
-- directory). It takes a brief write lock on `trades` while it builds —
-- apply off-peak.

create index if not exists trades_missing_fill_idx
  on public.trades (closed_at desc)
  where status = 'closed'
    and broker_account_id is not null
    and metaapi_order_id is not null
    and (close_price is null or profit is null);
