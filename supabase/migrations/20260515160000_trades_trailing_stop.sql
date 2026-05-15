/*
  # Trailing stop (single-trade mode, worker-managed)

  When manual trailing is enabled and trade_style is not multi, the executor
  snapshots trail settings onto the trades row. trailingStopMonitor polls
  open trades with trail_peak_price set and moves stop loss via /OrderModify.
*/

alter table public.trades
  add column if not exists trail_peak_price numeric(20, 8),
  add column if not exists trail_last_sl numeric(20, 8),
  add column if not exists trail_start_pips numeric(12, 4),
  add column if not exists trail_step_pips numeric(12, 4),
  add column if not exists trail_distance_pips numeric(12, 4);

comment on column public.trades.trail_peak_price is
  'Best favorable price seen while trailing (buy: max bid, sell: min ask). NULL = no trail watch.';
comment on column public.trades.trail_last_sl is
  'Last stop loss applied by the trailing monitor (for step sizing).';
comment on column public.trades.trail_start_pips is
  'Profit pips required before trailing activates (snapshot at open).';
comment on column public.trades.trail_step_pips is
  'Minimum favorable SL move in pips between trail updates.';
comment on column public.trades.trail_distance_pips is
  'Stop distance in pips behind the favorable peak price.';

create index if not exists trades_trail_open_idx
  on public.trades (broker_account_id, symbol)
  where status = 'open' and trail_peak_price is not null;
