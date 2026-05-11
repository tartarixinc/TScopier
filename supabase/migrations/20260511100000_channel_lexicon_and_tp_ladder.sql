-- Channel-aware parser lexicon + TP ladder state on trades.

alter table public.trades
  add column if not exists tp_levels jsonb not null default '[]'::jsonb,
  add column if not exists tp_open boolean not null default false,
  add column if not exists tp_step_policy jsonb not null default '{}'::jsonb,
  add column if not exists next_tp_index integer not null default 1;

create table if not exists public.channel_signal_lexicon (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_id uuid not null references public.telegram_channels(id) on delete cascade,
  action_aliases jsonb not null default '{}'::jsonb,
  tp_aliases text[] not null default '{}',
  target_aliases text[] not null default '{}',
  unknown_tokens text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_signal_lexicon_channel_unique unique (channel_id)
);

alter table public.channel_signal_lexicon enable row level security;

create policy "Users can view own channel signal lexicon"
  on public.channel_signal_lexicon for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert own channel signal lexicon"
  on public.channel_signal_lexicon for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update own channel signal lexicon"
  on public.channel_signal_lexicon for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own channel signal lexicon"
  on public.channel_signal_lexicon for delete
  to authenticated
  using (auth.uid() = user_id);

create index if not exists channel_signal_lexicon_user_id_idx on public.channel_signal_lexicon(user_id);
create index if not exists channel_signal_lexicon_channel_id_idx on public.channel_signal_lexicon(channel_id);
