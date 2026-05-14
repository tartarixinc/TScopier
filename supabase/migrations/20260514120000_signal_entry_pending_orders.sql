/*
  # Signal entry price — broker pending orders (separate from range_pending_legs)

  "Use Signal Entry Price" deferred entries previously reused `range_pending_legs`
  as virtual triggers. They now live here and are paired with real MT
  BuyLimit / SellLimit orders visible on the broker.

  Cleanup: remove legacy virtual strict-entry rows from range_pending_legs.
*/

-- Legacy virtual strict-entry legs (no broker ticket) — remove so they are not
-- fired as surprise market orders after switching to broker pendings.
delete from public.range_pending_legs
where coalesce(comment, '') ilike '%:strictentry%'
   or coalesce(comment, '') ilike '%:strictentryagg%';

create table if not exists public.signal_entry_pending_orders (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  metaapi_account_id text not null,
  symbol text not null,
  trade_id uuid references public.trades(id) on delete set null,
  is_buy boolean not null,
  operation text not null,
  entry_price numeric(20, 8) not null,
  volume numeric(20, 8) not null,
  stoploss numeric(20, 8),
  takeprofit numeric(20, 8),
  slippage int not null default 20,
  comment text,
  expert_id int,
  broker_ticket text not null,
  status text not null default 'broker_pending',
  /** When set after fill, worker inserts `partial_tp_legs` for single-mode schedules. */
  partial_tp_plan jsonb,
  cancel_requested_at timestamptz,
  cancel_reason text,
  error_message text,
  filled_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists signal_entry_pending_orders_active_unique
  on public.signal_entry_pending_orders (signal_id, broker_account_id)
  where status = 'broker_pending';

create index if not exists signal_entry_pending_orders_status_account_idx
  on public.signal_entry_pending_orders (status, metaapi_account_id);

create index if not exists signal_entry_pending_orders_signal_idx
  on public.signal_entry_pending_orders (signal_id);

alter table public.signal_entry_pending_orders enable row level security;

create policy "Users can view own signal entry pendings"
  on public.signal_entry_pending_orders for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own signal entry pendings"
  on public.signal_entry_pending_orders for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own signal entry pendings"
  on public.signal_entry_pending_orders for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own signal entry pendings"
  on public.signal_entry_pending_orders for delete
  to authenticated
  using (auth.uid() = user_id);

comment on table public.signal_entry_pending_orders is
  'Tracks broker-side limit pendings for "Use Signal Entry Price" when the live quote defers entry; paired with trades.status=pending until fill or cancel.';

-- Extend basket-empty cleanup: request broker cancel for strict-entry pendings
-- when no open/pending trades remain for the signal (worker performs OrderClose).
create or replace function public.cancel_range_pending_legs_when_basket_empty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if new.status is distinct from 'closed' then
    return new;
  end if;

  if old.status = 'closed' then
    return new;
  end if;

  if new.signal_id is null then
    return new;
  end if;

  if exists (
    select 1
    from public.trades t
    where t.signal_id = new.signal_id
      and t.status in ('open', 'pending')
  ) then
    return new;
  end if;

  delete from public.range_pending_legs r
  where r.signal_id = new.signal_id;

  update public.signal_entry_pending_orders s
  set
    cancel_requested_at = coalesce(s.cancel_requested_at, now()),
    cancel_reason = coalesce(s.cancel_reason, 'basket_empty'),
    updated_at = now()
  where s.signal_id = new.signal_id
    and s.status = 'broker_pending'
    and s.cancel_requested_at is null;

  return new;
end;
$$;

comment on function public.cancel_range_pending_legs_when_basket_empty() is
  'AFTER UPDATE on trades: when no open/pending trades remain for signal_id, delete range_pending_legs and request cancel on signal_entry_pending_orders (worker closes broker pendings).';
