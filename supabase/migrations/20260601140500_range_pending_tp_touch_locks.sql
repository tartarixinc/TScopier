/*
  # range_pending_tp_locks

  Locks a range-layer basket (signal + broker + symbol) once price has touched
  any open-leg TP level. After lock:
    - no further range_pending_legs can fire
    - active pending/claimed legs are expired

  This table is the persistent source of truth shared by worker and edge sweep,
  so behavior survives deploys/restarts.
*/

create table if not exists public.range_pending_tp_locks (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  symbol text not null,
  lock_reason text not null default 'tp_touched',
  trigger_price numeric(20,8),
  trigger_side text,
  touched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists range_pending_tp_locks_basket_unique
  on public.range_pending_tp_locks (signal_id, broker_account_id, symbol);

create index if not exists range_pending_tp_locks_signal_idx
  on public.range_pending_tp_locks (signal_id);

alter table public.range_pending_tp_locks enable row level security;

create policy "Users can view own range pending tp locks"
  on public.range_pending_tp_locks for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own range pending tp locks"
  on public.range_pending_tp_locks for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own range pending tp locks"
  on public.range_pending_tp_locks for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own range pending tp locks"
  on public.range_pending_tp_locks for delete
  to authenticated
  using (auth.uid() = user_id);

comment on table public.range_pending_tp_locks is
  'Persistent lock set when basket TP is touched; prevents further range pending fires for the same signal+broker+symbol.';

