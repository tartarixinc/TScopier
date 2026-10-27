-- Complete Social Trading account-mode, authorization, and preview-simulation
-- behavior. The synthetic path is server-controlled and default-off.

create table if not exists public.social_copy_runtime_config (
  singleton boolean primary key default true check (singleton),
  environment_name text not null default 'unconfigured',
  allow_synthetic_participants boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.social_copy_runtime_config (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.social_copy_runtime_config enable row level security;
revoke all on table public.social_copy_runtime_config from public, anon, authenticated;
grant select, insert, update on table public.social_copy_runtime_config to service_role;

comment on table public.social_copy_runtime_config is
  'Server-only Social Trading environment gates. Synthetic participation defaults off and must only be enabled in an isolated preview project.';
comment on column public.social_copy_runtime_config.allow_synthetic_participants is
  'Allows persisted synthetic subscription lifecycles. It never authorizes broker execution; workers must use the isolated synthetic simulation path.';

create or replace function public.social_copy_synthetic_participants_enabled()
returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((
    select c.allow_synthetic_participants
    from public.social_copy_runtime_config c
    where c.singleton = true
      and c.environment_name = 'migration-preview'
  ), false);
$$;

revoke all on function public.social_copy_synthetic_participants_enabled()
  from public, anon, authenticated;

create or replace function public.social_broker_account_mode(p_broker_account_id uuid)
returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  with account_values as (
    select
      lower(btrim(coalesce(b.linked_account_type, ''))) as linked_type,
      lower(btrim(coalesce(
        case lower(coalesce(b.provider, ''))
          when 'ctrader' then b.ctrader_environment
          when 'binance' then b.binance_environment
          when 'bybit' then b.bybit_environment
          when 'tradelocker' then b.tradelocker_environment
          else null
        end,
        ''
      ))) as provider_environment
    from public.broker_accounts b
    where b.id = p_broker_account_id
  ), normalized as (
    select
      case when linked_type in ('demo', 'practice') then 'demo'
           when linked_type = 'live' then 'live'
           else 'unknown' end as linked_mode,
      case when provider_environment in ('demo', 'live') then provider_environment
           else 'unknown' end as environment_mode
    from account_values
  )
  select case
    when linked_mode <> 'unknown' and environment_mode <> 'unknown'
      and linked_mode <> environment_mode then 'unknown'
    when linked_mode <> 'unknown' then linked_mode
    when environment_mode <> 'unknown' then environment_mode
    else 'unknown'
  end
  from normalized;
$$;

revoke all on function public.social_broker_account_mode(uuid)
  from public, anon, authenticated;
grant execute on function public.social_broker_account_mode(uuid) to service_role;

alter table public.social_copy_subscriptions
  add column if not exists source_account_mode text not null default 'unknown'
    check (source_account_mode in ('demo', 'live', 'unknown')),
  add column if not exists destination_account_mode text not null default 'unknown'
    check (destination_account_mode in ('demo', 'live', 'unknown')),
  add column if not exists execution_path text not null default 'broker'
    check (execution_path in ('broker', 'synthetic_simulation'));

update public.social_copy_subscriptions subscription
set source_account_mode = coalesce(public.social_broker_account_mode(source.broker_account_id), 'unknown'),
    destination_account_mode = coalesce(public.social_broker_account_mode(subscription.destination_broker_account_id), 'unknown'),
    execution_path = case
      when source.is_synthetic = true
        or source_profile.is_synthetic_demo = true
        or exists (
          select 1 from public.social_profiles subscriber_profile
          where subscriber_profile.user_id = subscription.subscriber_user_id
            and subscriber_profile.is_synthetic_demo = true)
      then 'synthetic_simulation'
      else 'broker'
    end
from public.social_copy_sources source
join public.social_profiles source_profile on source_profile.user_id = source.trader_user_id
where source.id = subscription.source_id;


-- The historical guard correctly protected production but would pause every
-- preview source whenever the idempotent seed refreshed its synthetic marker.
drop trigger if exists social_copy_sources_pause_synthetic_subscriptions
  on public.social_copy_sources;
comment on column public.social_copy_subscriptions.source_account_mode is
  'Trusted source mode captured when the subscription is created.';
comment on column public.social_copy_subscriptions.destination_account_mode is
  'Trusted destination mode captured when the subscription is created.';
comment on column public.social_copy_subscriptions.execution_path is
  'broker for genuine accounts; synthetic_simulation permanently prevents broker execution for synthetic participants.';

create or replace function public.social_source_performance_eligibility(p_source_id uuid)
returns table (eligible boolean, reason text)
language sql stable security definer set search_path = pg_catalog, public as $$
  with source_context as (
    select
      s.id, s.status, s.trader_user_id, s.broker_account_id, s.is_synthetic,
      sp.is_synthetic_demo,
      lower(coalesce(nullif(b.provider, ''), 'fxsocket')) as provider,
      upper(coalesce(b.platform, '')) as platform,
      b.is_active,
      lower(coalesce(b.connection_status, '')) as connection_status,
      coalesce(public.social_broker_account_mode(b.id), 'unknown') as account_mode,
      b.last_synced_at
    from public.social_copy_sources s
    join public.broker_accounts b on b.id = s.broker_account_id and b.user_id = s.trader_user_id
    join public.social_profiles sp on sp.user_id = s.trader_user_id
    where s.id = p_source_id
  ), scoped as (
    select distinct on (t.broker_account_id, coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text))
      t.id, t.broker_account_id, t.metaapi_order_id, t.status, t.opened_at,
      t.closed_at, t.profit, t.created_at
    from public.trades t
    join source_context sc on sc.broker_account_id = t.broker_account_id
    where (lower(t.status) = 'open' or t.closed_at is not null or lower(t.status) = 'closed')
      and not exists (
        select 1
        from public.social_copy_subscriptions sub
        join public.social_copy_trade_mappings map on map.subscription_id = sub.id
        where sub.destination_broker_account_id = t.broker_account_id
          and map.destination_ticket is not null
          and map.destination_ticket = t.metaapi_order_id
      )
    order by t.broker_account_id,
      coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text),
      t.created_at desc, t.id desc
  ), facts as (
    select
      count(*) filter (where lower(status) = 'closed' or closed_at is not null) as closed_count,
      count(*) filter (where (lower(status) = 'closed' or closed_at is not null)
        and (profit is null or metaapi_order_id is null or btrim(metaapi_order_id) = '')) as incomplete_count,
      min(opened_at) filter (where lower(status) = 'closed' or closed_at is not null) as period_start,
      max(closed_at) filter (where lower(status) = 'closed' or closed_at is not null) as period_end
    from scoped
  )
  select
    case
      when sc.id is null then false
      when sc.status <> 'published' then false
      when (sc.is_synthetic or sc.is_synthetic_demo)
        and not public.social_copy_synthetic_participants_enabled() then false
      when sc.provider not in ('fxsocket', 'mtapi') or sc.platform not in ('MT4', 'MT5') then false
      when sc.account_mode not in ('demo', 'live') then false
      when not sc.is_active or sc.connection_status not in ('connected', 'healthy') then false
      when sc.last_synced_at is null then false
      when sc.last_synced_at < now() - interval '15 minutes' then false
      when coalesce(f.incomplete_count, 0) > 0 then false
      when coalesce(f.closed_count, 0) < 10 then false
      when f.period_start is null or f.period_end is null
        or f.period_end - f.period_start < interval '7 days' then false
      else true
    end,
    case
      when sc.id is null then 'source_missing'
      when sc.status <> 'published' then 'source_not_published'
      when (sc.is_synthetic or sc.is_synthetic_demo)
        and not public.social_copy_synthetic_participants_enabled() then 'synthetic_preview_disabled'
      when sc.provider not in ('fxsocket', 'mtapi') or sc.platform not in ('MT4', 'MT5') then 'source_unsupported'
      when sc.account_mode not in ('demo', 'live') then 'account_mode_unknown'
      when not sc.is_active then 'source_inactive'
      when sc.connection_status = 'error' then 'sync_failed'
      when sc.connection_status not in ('connected', 'healthy') then 'source_disconnected'
      when sc.last_synced_at is null then 'sync_pending'
      when sc.last_synced_at < now() - interval '15 minutes' then 'history_stale'
      when coalesce(f.incomplete_count, 0) > 0 then 'history_incomplete'
      when coalesce(f.closed_count, 0) < 10 then 'minimum_trades_not_met'
      when f.period_start is null or f.period_end is null
        or f.period_end - f.period_start < interval '7 days' then 'minimum_period_not_met'
      else 'eligible'
    end
  from (select 1) seed
  left join source_context sc on true
  left join facts f on true;
$$;

revoke all on function public.social_source_performance_eligibility(uuid)
  from public, anon, authenticated;
grant execute on function public.social_source_performance_eligibility(uuid) to service_role;

comment on function public.social_source_performance_eligibility(uuid) is
  'Server-side eligibility for published owned Demo or Live MT sources with trusted mode, healthy/fresh sync, complete history, and preview-only synthetic gating.';

create or replace function public.publish_social_copy_source(
  p_broker_account_id uuid,
  p_label text default null
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_id uuid;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Social copy source publishing requires a verified account' using errcode = '42501';
  end if;
  if not public.social_follow_profile_is_eligible(v_actor) then
    raise exception 'Join the social directory before publishing a copy source' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.broker_accounts b
    where b.id = p_broker_account_id and b.user_id = v_actor
      and b.is_active = true
      and lower(coalesce(b.connection_status, '')) in ('connected', 'healthy')
      and lower(coalesce(nullif(b.provider, ''), 'fxsocket')) in ('fxsocket', 'mtapi')
      and upper(coalesce(b.platform, '')) in ('MT4', 'MT5')
      and public.social_broker_account_mode(b.id) in ('demo', 'live')
  ) then
    raise exception 'Broker account is not connected, supported, or mode-verified for Social Trading' using errcode = '55000';
  end if;

  insert into public.social_copy_sources (trader_user_id, broker_account_id, status, label)
  values (v_actor, p_broker_account_id, 'published', nullif(btrim(p_label), ''))
  on conflict (broker_account_id) do update set
    status = 'published', label = excluded.label, updated_at = now()
  where public.social_copy_sources.trader_user_id = v_actor
  returning id into v_id;
  if v_id is null then raise exception 'Copy source belongs to another trader' using errcode = '42501'; end if;
  return v_id;
end;
$$;

revoke all on function public.publish_social_copy_source(uuid, text) from public, anon;
grant execute on function public.publish_social_copy_source(uuid, text) to authenticated;

comment on function public.publish_social_copy_source(uuid, text) is
  'Shares one independently selected owned, connected, supported Demo or Live account without changing other shared accounts.';

drop function public.get_social_copy_sources(uuid);
create function public.get_social_copy_sources(p_trader_user_id uuid)
returns table (
  source_id uuid,
  label text,
  provider text,
  platform text,
  account_hint text,
  account_mode text,
  connection_healthy boolean,
  is_copy_eligible boolean,
  eligibility_reason text,
  is_synthetic boolean
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select s.id, coalesce(s.label, 'Copy source'),
    coalesce(b.provider, 'fxsocket'), b.platform,
    case
      when nullif(btrim(b.account_login), '') is null then 'Identifier unavailable'
      else repeat(chr(8226), 4) || right(btrim(b.account_login), 4)
    end,
    coalesce(public.social_broker_account_mode(b.id), 'unknown'),
    (b.is_active = true and lower(coalesce(b.connection_status, '')) in ('connected', 'healthy')),
    eligibility.eligible,
    eligibility.reason,
    (s.is_synthetic = true or sp.is_synthetic_demo = true)
  from public.social_copy_sources s
  join public.broker_accounts b on b.id = s.broker_account_id and b.user_id = s.trader_user_id
  join public.social_profiles sp on sp.user_id = s.trader_user_id and sp.is_listed = true
  cross join lateral public.social_source_performance_eligibility(s.id) eligibility
  where s.trader_user_id = p_trader_user_id and s.status = 'published'
    and (sp.access_mode = 'open' or s.trader_user_id = auth.uid()
      or exists (select 1 from public.social_follow_relationships r
        where r.follower_user_id = auth.uid()
          and r.followed_user_id = s.trader_user_id
          and r.status = 'accepted'))
  order by s.created_at, s.id;
$$;

revoke all on function public.get_social_copy_sources(uuid) from public, anon;
grant execute on function public.get_social_copy_sources(uuid) to authenticated;

create or replace function public.reject_synthetic_social_copy_subscription()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_synthetic boolean;
begin
  select source.is_synthetic = true
      or source_profile.is_synthetic_demo = true
      or coalesce(subscriber_profile.is_synthetic_demo, false) = true
  into v_synthetic
  from public.social_copy_sources source
  join public.social_profiles source_profile on source_profile.user_id = source.trader_user_id
  left join public.social_profiles subscriber_profile on subscriber_profile.user_id = new.subscriber_user_id
  where source.id = new.source_id;

  if coalesce(v_synthetic, false) and not public.social_copy_synthetic_participants_enabled() then
    raise exception 'Synthetic Social Trading participants are disabled in this environment'
      using errcode = '42501';
  end if;
  if coalesce(v_synthetic, false) and new.execution_path <> 'synthetic_simulation' then
    raise exception 'Synthetic Social Trading subscriptions require the simulation execution path'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists reject_synthetic_social_copy_subscription on public.social_copy_subscriptions;
create trigger reject_synthetic_social_copy_subscription
before insert or update of source_id, subscriber_user_id, destination_broker_account_id, execution_path
on public.social_copy_subscriptions
for each row execute function public.reject_synthetic_social_copy_subscription();

revoke all on function public.reject_synthetic_social_copy_subscription()
  from public, anon, authenticated;

create or replace function public.create_social_copy_subscription(
  p_source_id uuid,
  p_destination_broker_account_id uuid,
  p_sizing_mode text,
  p_fixed_lot numeric,
  p_lot_multiplier numeric,
  p_max_lot numeric,
  p_max_daily_loss numeric default null,
  p_requested_account_mode text default 'demo',
  p_symbol_map jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_source public.social_copy_sources%rowtype;
  v_access text;
  v_source_mode text;
  v_destination_mode text;
  v_source_synthetic boolean := false;
  v_subscriber_synthetic boolean := false;
  v_execution_path text := 'broker';
  v_id uuid;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_profile_is_eligible(v_actor) then
    raise exception 'Join the social directory before copying a trader' using errcode = '55000';
  end if;

  select s, sp.access_mode, (s.is_synthetic = true or sp.is_synthetic_demo = true)
  into v_source, v_access, v_source_synthetic
  from public.social_copy_sources s
  join public.social_profiles sp on sp.user_id = s.trader_user_id
  cross join lateral public.social_source_performance_eligibility(s.id) eligibility
  where s.id = p_source_id and s.status = 'published' and sp.is_listed = true
    and eligibility.eligible = true;
  if not found then raise exception 'Social copy source is unavailable or ineligible' using errcode = 'P0002'; end if;
  if v_source.trader_user_id = v_actor then raise exception 'Users cannot copy themselves' using errcode = '23514'; end if;
  if v_access = 'private' and not exists (
    select 1 from public.social_follow_relationships r
    where r.follower_user_id = v_actor and r.followed_user_id = v_source.trader_user_id
      and r.status = 'accepted'
  ) then raise exception 'An accepted follow is required for this private trader' using errcode = '42501'; end if;

  if not exists (
    select 1 from public.broker_accounts b
    where b.id = p_destination_broker_account_id and b.user_id = v_actor
      and b.is_active = true
      and lower(coalesce(b.connection_status, '')) in ('connected', 'healthy')
      and lower(coalesce(nullif(b.provider, ''), 'fxsocket')) in ('fxsocket', 'mtapi')
      and upper(coalesce(b.platform, '')) in ('MT4', 'MT5')
  ) then
    raise exception 'Destination account is not owned, connected, or supported for Social Trading' using errcode = '42501';
  end if;

  v_source_mode := coalesce(public.social_broker_account_mode(v_source.broker_account_id), 'unknown');
  v_destination_mode := coalesce(public.social_broker_account_mode(p_destination_broker_account_id), 'unknown');
  if v_source_mode not in ('demo', 'live') or v_destination_mode not in ('demo', 'live') then
    raise exception 'Source and destination account modes must be verified' using errcode = '22023';
  end if;
  if p_requested_account_mode <> v_destination_mode then
    raise exception 'Destination account mode changed; review and confirm the selected account again' using errcode = '22023';
  end if;

  select coalesce(sp.is_synthetic_demo, false) into v_subscriber_synthetic
  from public.social_profiles sp where sp.user_id = v_actor;
  if v_source_synthetic or v_subscriber_synthetic then
    if not public.social_copy_synthetic_participants_enabled() then
      raise exception 'Synthetic Social Trading participants are disabled in this environment' using errcode = '42501';
    end if;
    v_execution_path := 'synthetic_simulation';
  end if;

  if p_sizing_mode not in ('fixed_lot', 'lot_multiplier', 'equity_ratio')
    or p_requested_account_mode not in ('demo', 'live')
    or coalesce(p_lot_multiplier, 0) <= 0 or coalesce(p_lot_multiplier, 0) > 100
    or coalesce(p_max_lot, 0) <= 0 or coalesce(p_max_lot, 0) > 1000
    or (p_sizing_mode = 'fixed_lot' and (coalesce(p_fixed_lot, 0) <= 0 or p_fixed_lot > p_max_lot))
    or (p_max_daily_loss is not null and p_max_daily_loss <= 0)
    or jsonb_typeof(coalesce(p_symbol_map, '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid social copy risk settings' using errcode = '22023';
  end if;

  insert into public.social_copy_subscriptions (
    source_id, source_trader_user_id, subscriber_user_id, destination_broker_account_id,
    sizing_mode, fixed_lot, lot_multiplier, max_lot, max_daily_loss,
    requested_account_mode, source_account_mode, destination_account_mode,
    execution_path, symbol_map
  ) values (
    p_source_id, v_source.trader_user_id, v_actor, p_destination_broker_account_id,
    p_sizing_mode, case when p_sizing_mode = 'fixed_lot' then p_fixed_lot else null end,
    p_lot_multiplier, p_max_lot, p_max_daily_loss,
    v_destination_mode, v_source_mode, v_destination_mode,
    v_execution_path, coalesce(p_symbol_map, '{}'::jsonb)
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A current subscription already exists for this source and destination' using errcode = '23505';
end;
$$;

revoke all on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb)
  from public, anon;
grant execute on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb)
  to authenticated;

create or replace function public.check_social_copy_subscription_authorization(p_subscription_id uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select case when current_user in ('service_role', 'postgres') then exists (
    select 1
    from public.social_copy_subscriptions s
    join public.social_copy_sources src on src.id = s.source_id
    join public.social_profiles sp on sp.user_id = src.trader_user_id
    left join public.social_profiles subscriber_profile on subscriber_profile.user_id = s.subscriber_user_id
    join public.broker_accounts source_account on source_account.id = src.broker_account_id
    join public.broker_accounts destination_account on destination_account.id = s.destination_broker_account_id
    cross join lateral public.social_source_performance_eligibility(src.id) eligibility
    where s.id = p_subscription_id
      and eligibility.eligible = true
      and src.status = 'published' and sp.is_listed = true
      and source_account.user_id = src.trader_user_id
      and destination_account.user_id = s.subscriber_user_id
      and destination_account.is_active = true
      and lower(coalesce(destination_account.connection_status, '')) in ('connected', 'healthy')
      and lower(coalesce(nullif(destination_account.provider, ''), 'fxsocket')) in ('fxsocket', 'mtapi')
      and upper(coalesce(destination_account.platform, '')) in ('MT4', 'MT5')
      and public.social_broker_account_mode(source_account.id) = s.source_account_mode
      and public.social_broker_account_mode(destination_account.id) = s.destination_account_mode
      and s.requested_account_mode = s.destination_account_mode
      and (
        ((src.is_synthetic = true or sp.is_synthetic_demo = true
          or coalesce(subscriber_profile.is_synthetic_demo, false) = true)
          and public.social_copy_synthetic_participants_enabled()
          and s.execution_path = 'synthetic_simulation')
        or
        ((src.is_synthetic = false and sp.is_synthetic_demo = false
          and coalesce(subscriber_profile.is_synthetic_demo, false) = false)
          and s.execution_path = 'broker')
      )
      and (sp.access_mode = 'open' or exists (
        select 1 from public.social_follow_relationships r
        where r.follower_user_id = s.subscriber_user_id
          and r.followed_user_id = src.trader_user_id
          and r.status = 'accepted'
      ))
  ) else false end;
$$;

revoke all on function public.check_social_copy_subscription_authorization(uuid)
  from public, anon, authenticated;
grant execute on function public.check_social_copy_subscription_authorization(uuid) to service_role;
