/*
  # TScopier - Basket SL/TP reconcile jobs

  Persists desired per-leg SL/TP when merge modify fails or is partial.
  Worker BasketSlTpReconcileMonitor (15s) and edge basket-sl-tp-sweep (60s cron)
  retry OrderModify until legs match or max_attempts is reached.
*/

create table if not exists public.basket_reconcile_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  anchor_signal_id uuid not null references public.signals(id) on delete cascade,
  source_signal_id uuid not null references public.signals(id) on delete cascade,
  channel_id uuid references public.telegram_channels(id) on delete set null,
  symbol text not null,
  direction text not null check (direction in ('buy', 'sell')),
  per_leg_targets jsonb not null default '[]'::jsonb,
  virtual_pendings_snapshot jsonb,
  n_imm_cwe int not null default 0,
  override_tp numeric(20,8),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'done', 'failed')),
  attempts int not null default 0,
  max_attempts int not null default 48,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint basket_reconcile_jobs_broker_anchor_unique unique (broker_account_id, anchor_signal_id)
);

create table if not exists public.basket_reconcile_legs (
  trade_id uuid primary key references public.trades(id) on delete cascade,
  job_id uuid not null references public.basket_reconcile_jobs(id) on delete cascade,
  leg_index int not null default 0,
  ticket bigint,
  desired_sl numeric(20,8),
  desired_tp numeric(20,8),
  last_error text,
  modified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists basket_reconcile_jobs_status_next_idx
  on public.basket_reconcile_jobs(status, next_run_at)
  where status in ('pending', 'claimed');

create index if not exists basket_reconcile_jobs_user_idx
  on public.basket_reconcile_jobs(user_id);

create index if not exists basket_reconcile_legs_job_idx
  on public.basket_reconcile_legs(job_id);

alter table public.basket_reconcile_jobs enable row level security;
alter table public.basket_reconcile_legs enable row level security;

create policy "Users can view own basket reconcile jobs"
  on public.basket_reconcile_jobs for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can view own basket reconcile legs"
  on public.basket_reconcile_legs for select
  to authenticated
  using (
    exists (
      select 1 from public.basket_reconcile_jobs j
      where j.id = basket_reconcile_legs.job_id and j.user_id = auth.uid()
    )
  );
