-- Discord signal sources share telegram_channels so broker links stay on the existing foreign keys.
-- A shadow row uses source_kind = 'discord' and channel_id = dc:<guild_id>:<channel_id>.
-- Discord rows count toward the plan channel allowance. TradingView stays excluded.

alter table public.telegram_channels
  drop constraint if exists telegram_channels_source_kind_check;

alter table public.telegram_channels
  add constraint telegram_channels_source_kind_check
  check (source_kind in ('telegram', 'tradingview', 'discord'));

create table if not exists public.discord_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  guild_id text not null,
  guild_name text not null default '',
  created_at timestamptz not null default now(),
  unique (user_id, guild_id)
);

create table if not exists public.discord_guild_channels (
  guild_id text not null,
  discord_channel_id text not null,
  name text not null,
  updated_at timestamptz not null default now(),
  primary key (guild_id, discord_channel_id)
);

create table if not exists public.discord_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  installation_id uuid not null references public.discord_installations (id) on delete cascade,
  guild_id text not null,
  discord_channel_id text not null,
  name text not null,
  channel_id uuid not null references public.telegram_channels (id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, discord_channel_id)
);

create index if not exists discord_channels_guild_channel_idx
  on public.discord_channels (guild_id, discord_channel_id);

alter table public.discord_installations enable row level security;
alter table public.discord_guild_channels enable row level security;
alter table public.discord_channels enable row level security;

drop policy if exists "Users can select own discord installations" on public.discord_installations;
create policy "Users can select own discord installations"
  on public.discord_installations for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own discord installations" on public.discord_installations;
create policy "Users can insert own discord installations"
  on public.discord_installations for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own discord installations" on public.discord_installations;
create policy "Users can update own discord installations"
  on public.discord_installations for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own discord installations" on public.discord_installations;
create policy "Users can delete own discord installations"
  on public.discord_installations for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can select installed discord guild channels" on public.discord_guild_channels;
create policy "Users can select installed discord guild channels"
  on public.discord_guild_channels for select
  to authenticated
  using (
    exists (
      select 1
      from public.discord_installations di
      where di.user_id = auth.uid()
        and di.guild_id = discord_guild_channels.guild_id
    )
  );

drop policy if exists "Users can select own discord channels" on public.discord_channels;
create policy "Users can select own discord channels"
  on public.discord_channels for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own discord channels" on public.discord_channels;
create policy "Users can insert own discord channels"
  on public.discord_channels for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.discord_installations di
      where di.id = installation_id
        and di.user_id = auth.uid()
        and di.guild_id = guild_id
    )
  );

drop policy if exists "Users can update own discord channels" on public.discord_channels;
create policy "Users can update own discord channels"
  on public.discord_channels for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own discord channels" on public.discord_channels;
create policy "Users can delete own discord channels"
  on public.discord_channels for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own discord channels shadow" on public.telegram_channels;
create policy "Users can insert own discord channels shadow"
  on public.telegram_channels for insert
  to authenticated
  with check (auth.uid() = user_id and source_kind = 'discord');

grant select, insert, update, delete on public.discord_installations to authenticated;
grant select on public.discord_guild_channels to authenticated;
grant select, insert, update, delete on public.discord_channels to authenticated;
