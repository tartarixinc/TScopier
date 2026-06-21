/*
  # TScopier - Virtual Range Pendings

  ## Overview
  Persists "virtual" averaging-down legs for Range Trading. Broker-side
  BuyLimit / SellLimit pendings are no longer placed; instead each leg is
  stored here with its trigger price and the worker (primary) + the
  range-pending-sweep edge function (60s backup) compare the live /Quote
  to the trigger and fire a MARKET OrderSend the moment the trigger is hit.

  Eliminates broker rejections from stops_level / freeze_level / minimum
  Limit-distance — the broker only ever sees market orders that already
  satisfy its constraints.

  ## Lifecycle
    pending  -> claimed  -> fired      (happy path)
    pending  -> claimed  -> failed     (OrderSend error)
    pending  -> expired               (expires_at < now())
    pending  -> cancelled             (manual / opposite signal)

  ## Concurrency
  `claimed_at` + `claimed_by` are used for CAS-style claiming. Both the
  worker and the edge function race to update status from 'pending' to
  'claimed' — the loser sees zero rows back and skips.
*/

create table if not exists public.range_pending_legs (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  metaapi_account_id text not null,
  symbol text not null,
  step_idx int not null,
  is_buy boolean not null,
  volume numeric(20,8) not null,
  anchor_price numeric(20,8) not null,
  trigger_price numeric(20,8) not null,
  stoploss numeric(20,8),
  takeprofit numeric(20,8),
  slippage int not null default 20,
  comment text,
  expert_id int,
  expires_at timestamptz,
  status text not null default 'pending',
  claimed_at timestamptz,
  claimed_by text,
  fired_at timestamptz,
  ticket text,
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.range_pending_legs enable row level security;

create policy "Users can view own range pending legs"
  on public.range_pending_legs for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own range pending legs"
  on public.range_pending_legs for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own range pending legs"
  on public.range_pending_legs for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own range pending legs"
  on public.range_pending_legs for delete
  to authenticated
  using (auth.uid() = user_id);

-- Hot path: poller groups pending rows by (account, symbol) and checks each
-- against the live quote.
create index if not exists range_pending_legs_status_symbol_idx
  on public.range_pending_legs(status, metaapi_account_id, symbol);

-- Cleanup queries (cancel-on-opposite-signal, close-all-by-signal).
create index if not exists range_pending_legs_signal_idx
  on public.range_pending_legs(signal_id);

-- Expiry sweep — partial index keeps it tiny.
create index if not exists range_pending_legs_expires_idx
  on public.range_pending_legs(expires_at)
  where status = 'pending';
