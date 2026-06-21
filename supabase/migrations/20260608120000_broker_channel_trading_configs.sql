-- Normalized per-broker, per-channel trading configuration (source of truth).
-- broker_accounts.channel_trading_configs JSONB is kept in sync via trigger for legacy readers.

create table if not exists public.broker_channel_trading_configs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  channel_id uuid not null references public.telegram_channels(id) on delete cascade,
  copier_mode text not null default 'manual',
  manual_settings jsonb not null default '{}'::jsonb,
  ai_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint broker_channel_trading_configs_copier_mode_check
    check (copier_mode in ('ai', 'manual')),
  constraint broker_channel_trading_configs_broker_channel_unique
    unique (broker_account_id, channel_id)
);

create index if not exists broker_channel_trading_configs_broker_idx
  on public.broker_channel_trading_configs (broker_account_id);

create index if not exists broker_channel_trading_configs_user_idx
  on public.broker_channel_trading_configs (user_id, updated_at desc);

comment on table public.broker_channel_trading_configs is
  'Authoritative per-channel copier settings for a linked broker account. JSONB on broker_accounts is synced from this table.';

grant select, insert, update, delete on public.broker_channel_trading_configs to authenticated;

alter table public.broker_channel_trading_configs enable row level security;

drop policy if exists "Users can view own broker channel trading configs"
  on public.broker_channel_trading_configs;
create policy "Users can view own broker channel trading configs"
  on public.broker_channel_trading_configs for select
  to authenticated
  using (
    exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  );

drop policy if exists "Users can insert own broker channel trading configs"
  on public.broker_channel_trading_configs;
create policy "Users can insert own broker channel trading configs"
  on public.broker_channel_trading_configs for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  );

drop policy if exists "Users can update own broker channel trading configs"
  on public.broker_channel_trading_configs;
create policy "Users can update own broker channel trading configs"
  on public.broker_channel_trading_configs for update
  to authenticated
  using (
    exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  );

drop policy if exists "Users can delete own broker channel trading configs"
  on public.broker_channel_trading_configs;
create policy "Users can delete own broker channel trading configs"
  on public.broker_channel_trading_configs for delete
  to authenticated
  using (
    exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  );

create or replace function public.set_broker_channel_trading_configs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists broker_channel_trading_configs_updated_at on public.broker_channel_trading_configs;
create trigger broker_channel_trading_configs_updated_at
  before update on public.broker_channel_trading_configs
  for each row
  execute function public.set_broker_channel_trading_configs_updated_at();

create or replace function public.sync_broker_channel_trading_configs_jsonb(p_broker_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.broker_accounts ba
  set channel_trading_configs = coalesce(
    (
      select jsonb_object_agg(
        lower(cfg.channel_id::text),
        jsonb_build_object(
          'copier_mode', cfg.copier_mode,
          'manual_settings', cfg.manual_settings,
          'ai_settings', cfg.ai_settings
        )
      )
      from public.broker_channel_trading_configs cfg
      where cfg.broker_account_id = p_broker_account_id
    ),
    '{}'::jsonb
  )
  where ba.id = p_broker_account_id;
end;
$$;

create or replace function public.trg_sync_broker_channel_trading_configs_jsonb()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bid uuid;
begin
  bid := coalesce(new.broker_account_id, old.broker_account_id);
  perform public.sync_broker_channel_trading_configs_jsonb(bid);
  return coalesce(new, old);
end;
$$;

drop trigger if exists broker_channel_trading_configs_sync_jsonb on public.broker_channel_trading_configs;
create trigger broker_channel_trading_configs_sync_jsonb
  after insert or update or delete on public.broker_channel_trading_configs
  for each row
  execute function public.trg_sync_broker_channel_trading_configs_jsonb();

-- Backfill from existing JSONB map (prefer per-channel row; fall back to broker-level settings).
insert into public.broker_channel_trading_configs (
  user_id,
  broker_account_id,
  channel_id,
  copier_mode,
  manual_settings,
  ai_settings
)
select
  ba.user_id,
  ba.id,
  tc.id,
  coalesce(
    nullif(cfg.value ->> 'copier_mode', ''),
    ba.copier_mode,
    'manual'
  ),
  coalesce(
    case
      when jsonb_typeof(cfg.value -> 'manual_settings') = 'object'
        then cfg.value -> 'manual_settings'
      else null
    end,
    ba.manual_settings,
    '{}'::jsonb
  ),
  coalesce(
    case
      when jsonb_typeof(cfg.value -> 'ai_settings') = 'object'
        then cfg.value -> 'ai_settings'
      else null
    end,
    ba.ai_settings,
    '{}'::jsonb
  )
from public.broker_accounts ba
cross join jsonb_each(coalesce(ba.channel_trading_configs, '{}'::jsonb)) as cfg(key, value)
inner join public.telegram_channels tc
  on lower(tc.id::text) = lower(cfg.key)
 and tc.user_id = ba.user_id
on conflict (broker_account_id, channel_id) do update
set
  copier_mode = excluded.copier_mode,
  manual_settings = excluded.manual_settings,
  ai_settings = excluded.ai_settings,
  updated_at = now();

-- Linked channels missing from JSONB but present on the broker whitelist.
insert into public.broker_channel_trading_configs (
  user_id,
  broker_account_id,
  channel_id,
  copier_mode,
  manual_settings,
  ai_settings
)
select
  ba.user_id,
  ba.id,
  tc.id,
  coalesce(ba.copier_mode, 'manual'),
  coalesce(ba.manual_settings, '{}'::jsonb),
  coalesce(ba.ai_settings, '{}'::jsonb)
from public.broker_accounts ba
cross join unnest(coalesce(ba.signal_channel_ids, '{}'::uuid[])) as linked(channel_id)
inner join public.telegram_channels tc
  on tc.id = linked.channel_id
 and tc.user_id = ba.user_id
where not exists (
  select 1
  from public.broker_channel_trading_configs existing
  where existing.broker_account_id = ba.id
    and existing.channel_id = tc.id
)
on conflict (broker_account_id, channel_id) do nothing;

-- Refresh JSONB mirrors for all brokers that have normalized rows.
do $$
declare
  rec record;
begin
  for rec in
    select distinct broker_account_id
    from public.broker_channel_trading_configs
  loop
    perform public.sync_broker_channel_trading_configs_jsonb(rec.broker_account_id);
  end loop;
end;
$$;
