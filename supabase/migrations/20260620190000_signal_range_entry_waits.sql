/*
  Virtual "Use signal range" entry waits — no broker pending order.
  Monitor polls /Quote and re-dispatches when price reaches signal level ± tolerance.
*/

create table if not exists public.signal_range_entry_waits (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  metaapi_account_id text not null,
  symbol text not null,
  is_buy boolean not null,
  entry_price numeric(20, 8),
  zone_lo numeric(20, 8),
  zone_hi numeric(20, 8),
  tolerance_pips int not null default 10,
  status text not null default 'waiting',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (signal_id, broker_account_id)
);

create index if not exists signal_range_entry_waits_status_account_idx
  on public.signal_range_entry_waits (status, metaapi_account_id);

create index if not exists signal_range_entry_waits_signal_idx
  on public.signal_range_entry_waits (signal_id);

create unique index if not exists signal_range_entry_waits_active_unique
  on public.signal_range_entry_waits (signal_id, broker_account_id)
  where status = 'waiting';

alter table public.signal_range_entry_waits enable row level security;

create policy "Users can view own signal range entry waits"
  on public.signal_range_entry_waits for select
  to authenticated
  using (auth.uid() = user_id);

comment on table public.signal_range_entry_waits is
  'Virtual entry gate for Range Trading "Use signal range": waits for live price at signal level ± tolerance without broker pending orders.';

-- Cancel virtual range entry waits when basket is flat (same as strict-entry pendings).
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

  update public.signal_range_entry_waits w
  set status = 'cancelled', updated_at = now()
  where w.signal_id = new.signal_id
    and w.status = 'waiting';

  return new;
end;
$$;
