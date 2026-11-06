-- WhatsApp signal sources share telegram_channels so broker links stay on the existing foreign keys.
-- A shadow row uses source_kind = 'whatsapp' and channel_id = wa:<groupJid>.
-- WhatsApp groups count toward the plan channel allowance. TradingView stays excluded.

alter table public.telegram_channels
  drop constraint if exists telegram_channels_source_kind_check;

alter table public.telegram_channels
  add constraint telegram_channels_source_kind_check
  check (source_kind in ('telegram', 'tradingview', 'discord', 'whatsapp'));

create table if not exists public.whatsapp_sessions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  phone text not null default '',
  display_name text not null default '',
  status text not null default 'disconnected',
  updated_at timestamptz not null default now(),
  constraint whatsapp_sessions_status_check check (status in ('qr', 'connected', 'disconnected'))
);

create table if not exists public.whatsapp_auth (
  user_id uuid primary key references auth.users (id) on delete cascade,
  creds jsonb not null,
  keys jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  group_jid text not null,
  name text not null,
  channel_id uuid not null references public.telegram_channels (id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, group_jid)
);

create index if not exists whatsapp_groups_jid_idx
  on public.whatsapp_groups (group_jid);

alter table public.whatsapp_sessions enable row level security;
alter table public.whatsapp_auth enable row level security;
alter table public.whatsapp_groups enable row level security;

drop policy if exists "Users can select own whatsapp session" on public.whatsapp_sessions;
create policy "Users can select own whatsapp session"
  on public.whatsapp_sessions for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can select own whatsapp groups" on public.whatsapp_groups;
create policy "Users can select own whatsapp groups"
  on public.whatsapp_groups for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own whatsapp groups" on public.whatsapp_groups;
create policy "Users can insert own whatsapp groups"
  on public.whatsapp_groups for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own whatsapp groups" on public.whatsapp_groups;
create policy "Users can update own whatsapp groups"
  on public.whatsapp_groups for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own whatsapp groups" on public.whatsapp_groups;
create policy "Users can delete own whatsapp groups"
  on public.whatsapp_groups for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own whatsapp channels shadow" on public.telegram_channels;
create policy "Users can insert own whatsapp channels shadow"
  on public.telegram_channels for insert
  to authenticated
  with check (auth.uid() = user_id and source_kind = 'whatsapp');

grant select on public.whatsapp_sessions to authenticated;
grant select, insert, update, delete on public.whatsapp_groups to authenticated;
