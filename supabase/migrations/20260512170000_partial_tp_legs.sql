/*
  # TSCopier - Single-trade partial TP closes

  ## Overview
  When `trade_style = 'single'` the planner emits ONE broker order with the
  full `manualLot`. Historically that order's takeprofit was wired to TP1 of
  the signal and the `tp_lots` percentage rows (50/30/20) were ignored —
  they only applied to the multi-trade lot split.

  This migration persists per-TP partial closes for single-mode trades so a
  new worker monitor (`partialTpMonitor.ts`) can /OrderClose a slice of the
  position when the live quote crosses each early TP. The broker order's
  takeprofit is set to the LAST enabled-bucket TP — anything left over after
  the worker's partials rides there.

  Example: 1.0 lot single trade, TPs = [TP1, TP2, TP3], percent rows =
  50 / 30 / 20:
    - Broker order goes out with takeprofit = TP3, volume = 1.0.
    - partial_tp_legs rows: (tp_idx=1, trigger=TP1, close_lots=0.50),
      (tp_idx=2, trigger=TP2, close_lots=0.30).
    - When bid reaches TP1, monitor /OrderClose 0.50; remaining = 0.50.
    - When bid reaches TP2, monitor /OrderClose 0.30; remaining = 0.20.
    - When bid reaches TP3, broker auto-closes the remaining 0.20.

  ## Lifecycle
    pending  -> claimed  -> fired      (happy path)
    pending  -> claimed  -> failed     (OrderClose error)
    pending  -> cancelled              (parent trade closed by user / SL)

  ## Concurrency
  Same CAS-claim model as range_pending_legs — `claimed_at` + `claimed_by`
  let multiple workers (or a worker + an edge cron) race safely. The loser
  sees zero rows back from the UPDATE and walks away.
*/

create table if not exists public.partial_tp_legs (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references public.trades(id) on delete cascade,
  signal_id uuid not null references public.signals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  metaapi_account_id text not null,
  symbol text not null,
  is_buy boolean not null,
  tp_idx int not null,
  trigger_price numeric(20,8) not null,
  close_lots numeric(20,8) not null,
  status text not null default 'pending',
  claimed_at timestamptz,
  claimed_by text,
  fired_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.partial_tp_legs enable row level security;

create policy "Users can view own partial tp legs"
  on public.partial_tp_legs for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own partial tp legs"
  on public.partial_tp_legs for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own partial tp legs"
  on public.partial_tp_legs for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own partial tp legs"
  on public.partial_tp_legs for delete
  to authenticated
  using (auth.uid() = user_id);

-- Hot path: poller groups pending rows by (account, symbol) and checks each
-- against the live quote. Partial index keeps the working set tiny — most
-- rows fire within minutes of being inserted and then sit in 'fired'.
create index if not exists partial_tp_legs_pending_idx
  on public.partial_tp_legs(metaapi_account_id, symbol)
  where status = 'pending';

-- Cancel-on-parent-close: when a trade closes (SL hit / manual close) we
-- need to nuke its pending partials.
create index if not exists partial_tp_legs_trade_idx
  on public.partial_tp_legs(trade_id);

-- Diagnostic / UI: list pending partials for a signal.
create index if not exists partial_tp_legs_signal_idx
  on public.partial_tp_legs(signal_id);
