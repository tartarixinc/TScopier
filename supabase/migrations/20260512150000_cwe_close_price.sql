/*
  # TScopier - Close Worse Entries (worker-managed close)

  ## Overview
  Close-Worse-Entries used to inject a static `takeprofit` price on every
  CWE-eligible leg (immediates + N shallowest virtual pendings). Setting a
  hard TP on a buy that's already in profit, or on XAUUSD inside the broker's
  stops/freeze zone, repeatedly produced "Invalid stops" errors and could
  not be retried without losing the close-at-+X-pips intent.

  This migration moves CWE close enforcement to the worker:

  *  trades.cwe_close_price — the bid/ask threshold at which the worker
     should auto-close this trade via /OrderClose. NULL means "no CWE watch".
     A new worker monitor (cweCloseMonitor.ts) polls open trades with this
     field set, groups them by (account, symbol), reads /Quote once per
     group, and closes any whose threshold has been crossed:
       buy   → close when bid >= cwe_close_price
       sell  → close when ask <= cwe_close_price

  *  range_pending_legs.cwe_close_price — same value, propagated when a
     virtual pending is filed by the executor and carried over to the
     `trades` row when the pending fires as a market order. This means
     CWE-tagged pendings that fill mid-basket automatically join the
     watched cohort and close with their siblings.

  The legs no longer carry a broker-side TP at all (executor sets
  takeprofit = 0 on CWE legs) — the SL still rides, but the close trigger
  is entirely worker-driven.
*/

alter table public.trades
  add column if not exists cwe_close_price numeric(20,8);

comment on column public.trades.cwe_close_price is
  'When set, worker monitors live /Quote and closes the position once the '
  'CWE threshold is crossed (buy: bid >= price, sell: ask <= price). NULL '
  'means no worker-managed close is pending. Cleared on close/error.';

alter table public.range_pending_legs
  add column if not exists cwe_close_price numeric(20,8);

comment on column public.range_pending_legs.cwe_close_price is
  'CWE close threshold inherited by the trade row when this pending fires '
  'as a market order. NULL means the leg is not part of the worse-entries '
  'basket and will keep its own bucket TP instead.';

-- Hot path for cweCloseMonitor: SELECT open trades that need watching.
-- Partial index keeps the working set tiny (most trades are not CWE-tagged).
create index if not exists trades_cwe_open_idx
  on public.trades(broker_account_id, symbol)
  where status = 'open' and cwe_close_price is not null;
