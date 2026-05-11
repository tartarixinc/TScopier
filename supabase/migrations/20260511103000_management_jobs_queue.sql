create table if not exists public.management_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  signal_id uuid not null references public.signals(id) on delete cascade,
  channel_id uuid references public.telegram_channels(id) on delete set null,
  action text not null,
  parsed_data jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint management_jobs_signal_unique unique (signal_id)
);

alter table public.management_jobs enable row level security;

create policy "Users can view own management jobs"
  on public.management_jobs for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own management jobs"
  on public.management_jobs for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own management jobs"
  on public.management_jobs for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own management jobs"
  on public.management_jobs for delete
  to authenticated
  using (auth.uid() = user_id);

create index if not exists management_jobs_status_next_run_idx
  on public.management_jobs(status, next_run_at);

create index if not exists management_jobs_user_id_idx
  on public.management_jobs(user_id);
