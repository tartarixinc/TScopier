-- Persistent, cross-user social copy trading.
-- Deliberately separate from broker_copy_links: those rows are same-owner
-- configuration-map links and are not an authorization boundary for social copying.

create table public.social_copy_sources (
  id uuid primary key default gen_random_uuid(),
  trader_user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.broker_accounts(id) on delete restrict,
  status text not null default 'published' check (status in ('published', 'paused', 'retired')),
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (broker_account_id)
);

comment on table public.social_copy_sources is
  'Explicit trader opt-in publishing a broker account as a social-copy source. Contains no credentials.';

create table public.social_copy_subscriptions (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.social_copy_sources(id) on delete restrict,
  source_trader_user_id uuid not null references auth.users(id) on delete restrict,
  subscriber_user_id uuid not null references auth.users(id) on delete cascade,
  destination_broker_account_id uuid not null references public.broker_accounts(id) on delete restrict,
  sizing_mode text not null check (sizing_mode in ('fixed_lot', 'lot_multiplier', 'equity_ratio')),
  fixed_lot numeric,
  lot_multiplier numeric not null default 1,
  max_lot numeric not null,
  max_daily_loss numeric,
  requested_account_mode text not null default 'demo' check (requested_account_mode in ('demo', 'live')),
  symbol_map jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (
    status in ('pending', 'active', 'paused', 'stopped', 'error', 'emergency_stopped')
  ),
  desired_status text not null default 'active' check (desired_status in ('active', 'paused', 'stopped')),
  error_code text,
  error_detail text,
  worker_acknowledged_at timestamptz,
  last_reconciled_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stopped_at timestamptz,
  constraint social_copy_subscription_not_self check (source_trader_user_id <> subscriber_user_id),
  constraint social_copy_fixed_lot_valid check (
    (sizing_mode = 'fixed_lot' and fixed_lot is not null and fixed_lot > 0)
    or (sizing_mode <> 'fixed_lot' and fixed_lot is null)
  ),
  constraint social_copy_multiplier_valid check (lot_multiplier > 0 and lot_multiplier <= 100),
  constraint social_copy_max_lot_valid check (max_lot > 0 and max_lot <= 1000),
  constraint social_copy_daily_loss_valid check (max_daily_loss is null or max_daily_loss > 0),
  constraint social_copy_symbol_map_object check (jsonb_typeof(symbol_map) = 'object')
);

create unique index social_copy_subscriptions_current_pair_idx
  on public.social_copy_subscriptions (source_id, destination_broker_account_id)
  where status not in ('stopped', 'emergency_stopped');
create index social_copy_subscriptions_worker_idx
  on public.social_copy_subscriptions (desired_status, status, lease_expires_at);
create index social_copy_subscriptions_subscriber_idx
  on public.social_copy_subscriptions (subscriber_user_id, created_at desc);

create table public.social_copy_trade_mappings (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.social_copy_subscriptions(id) on delete restrict,
  source_ticket text not null,
  destination_ticket text,
  source_symbol text not null,
  destination_symbol text not null,
  source_side text not null check (source_side in ('buy', 'sell')),
  source_volume numeric not null check (source_volume > 0),
  destination_volume numeric not null check (destination_volume > 0),
  source_stop_loss numeric,
  source_take_profit numeric,
  state text not null default 'opening' check (state in ('opening', 'open', 'closing', 'closed', 'error', 'uncertain')),
  broker_comment text not null,
  opened_at timestamptz,
  closed_at timestamptz,
  last_error_code text,
  last_error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, source_ticket),
  unique (subscription_id, broker_comment)
);

create table public.social_copy_execution_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.social_copy_subscriptions(id) on delete restrict,
  mapping_id uuid references public.social_copy_trade_mappings(id) on delete restrict,
  source_ticket text not null,
  action text not null check (action in ('activate', 'open', 'modify', 'close', 'unsupported', 'reconcile')),
  idempotency_key text not null,
  status text not null default 'claimed' check (status in ('claimed', 'succeeded', 'failed', 'uncertain', 'skipped')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  request_payload jsonb not null default '{}'::jsonb,
  result_payload jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (subscription_id, idempotency_key)
);

create index social_copy_trade_mappings_open_idx
  on public.social_copy_trade_mappings (subscription_id, state);
create index social_copy_execution_events_subscription_idx
  on public.social_copy_execution_events (subscription_id, created_at desc);

create or replace function public.set_social_copy_updated_at()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin new.updated_at := now(); return new; end;
$$;

create trigger social_copy_sources_updated_at before update on public.social_copy_sources
  for each row execute function public.set_social_copy_updated_at();
create trigger social_copy_subscriptions_updated_at before update on public.social_copy_subscriptions
  for each row execute function public.set_social_copy_updated_at();
create trigger social_copy_trade_mappings_updated_at before update on public.social_copy_trade_mappings
  for each row execute function public.set_social_copy_updated_at();
create trigger social_copy_execution_events_updated_at before update on public.social_copy_execution_events
  for each row execute function public.set_social_copy_updated_at();

alter table public.social_copy_sources enable row level security;
alter table public.social_copy_subscriptions enable row level security;
alter table public.social_copy_trade_mappings enable row level security;
alter table public.social_copy_execution_events enable row level security;

revoke all on table public.social_copy_sources from anon, authenticated;
revoke all on table public.social_copy_subscriptions from anon, authenticated;
revoke all on table public.social_copy_trade_mappings from anon, authenticated;
revoke all on table public.social_copy_execution_events from anon, authenticated;
grant select on table public.social_copy_sources to authenticated;
grant select on table public.social_copy_subscriptions to authenticated;
grant select on table public.social_copy_trade_mappings to authenticated;
grant select on table public.social_copy_execution_events to authenticated;
grant all on table public.social_copy_sources to service_role;
grant all on table public.social_copy_subscriptions to service_role;
grant all on table public.social_copy_trade_mappings to service_role;
grant all on table public.social_copy_execution_events to service_role;

create policy "Owners can view social copy sources" on public.social_copy_sources
  for select to authenticated using (trader_user_id = auth.uid());
create policy "Subscribers can view own social copy subscriptions" on public.social_copy_subscriptions
  for select to authenticated using (subscriber_user_id = auth.uid());
create policy "Subscribers can view own social copy mappings" on public.social_copy_trade_mappings
  for select to authenticated using (exists (
    select 1 from public.social_copy_subscriptions s
    where s.id = subscription_id and s.subscriber_user_id = auth.uid()
  ));
create policy "Subscribers can view own social copy events" on public.social_copy_execution_events
  for select to authenticated using (exists (
    select 1 from public.social_copy_subscriptions s
    where s.id = subscription_id and s.subscriber_user_id = auth.uid()
  ));

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
    select 1 from public.broker_accounts b where b.id = p_broker_account_id and b.user_id = v_actor
  ) then raise exception 'Broker account is not owned by the current user' using errcode = '42501'; end if;

  insert into public.social_copy_sources (trader_user_id, broker_account_id, status, label)
  values (v_actor, p_broker_account_id, 'published', nullif(btrim(p_label), ''))
  on conflict (broker_account_id) do update set
    status = 'published', label = excluded.label
  where public.social_copy_sources.trader_user_id = v_actor
  returning id into v_id;
  if v_id is null then raise exception 'Copy source belongs to another trader' using errcode = '42501'; end if;
  return v_id;
end;
$$;

create or replace function public.set_social_copy_source_status(p_source_id uuid, p_status text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if p_status not in ('published', 'paused', 'retired') then
    raise exception 'Invalid copy source status' using errcode = '22023';
  end if;
  update public.social_copy_sources set status = p_status
  where id = p_source_id and trader_user_id = v_actor;
  if not found then raise exception 'Copy source was not found' using errcode = 'P0002'; end if;
  if p_status <> 'published' then
    update public.social_copy_subscriptions set desired_status = 'paused'
    where source_id = p_source_id and status in ('pending', 'active');
  end if;
end;
$$;

create or replace function public.get_social_copy_sources(p_trader_user_id uuid)
returns table (source_id uuid, trader_user_id uuid, label text, provider text, platform text, account_mode text, connection_healthy boolean)
language sql stable security definer set search_path = pg_catalog, public as $$
  select s.id, s.trader_user_id, coalesce(s.label, 'Copy source'),
    coalesce(b.provider, 'fxsocket'), b.platform,
    case when lower(coalesce(b.linked_account_type, '')) in ('demo', 'practice') then 'demo' else 'live' end,
    (b.is_active = true and b.connection_status in ('connected', 'healthy'))
  from public.social_copy_sources s
  join public.broker_accounts b on b.id = s.broker_account_id
  join public.social_profiles sp on sp.user_id = s.trader_user_id and sp.is_listed = true
  where s.trader_user_id = p_trader_user_id and s.status = 'published'
    and (
      sp.access_mode = 'open'
      or s.trader_user_id = auth.uid()
      or exists (select 1 from public.social_follow_relationships r
        where r.follower_user_id = auth.uid() and r.followed_user_id = s.trader_user_id and r.status = 'accepted')
    );
$$;

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
declare v_actor uuid := auth.uid(); v_source public.social_copy_sources%rowtype; v_access text; v_id uuid;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_profile_is_eligible(v_actor) then
    raise exception 'Join the social directory before copying a trader' using errcode = '55000';
  end if;
  select s.* into v_source
  from public.social_copy_sources s join public.social_profiles sp on sp.user_id = s.trader_user_id
  where s.id = p_source_id and s.status = 'published' and sp.is_listed = true;
  if not found then raise exception 'Social copy source is unavailable' using errcode = 'P0002'; end if;
  select sp.access_mode into v_access from public.social_profiles sp where sp.user_id = v_source.trader_user_id;
  if v_source.trader_user_id = v_actor then raise exception 'Users cannot copy themselves' using errcode = '23514'; end if;
  if v_access = 'private' and not exists (
    select 1 from public.social_follow_relationships r
    where r.follower_user_id = v_actor and r.followed_user_id = v_source.trader_user_id and r.status = 'accepted'
  ) then raise exception 'An accepted follow is required for this private trader' using errcode = '42501'; end if;
  if not exists (select 1 from public.broker_accounts b
    where b.id = p_destination_broker_account_id and b.user_id = v_actor) then
    raise exception 'Destination broker account is not owned by the current user' using errcode = '42501';
  end if;
  if p_sizing_mode not in ('fixed_lot', 'lot_multiplier', 'equity_ratio')
    or p_requested_account_mode not in ('demo', 'live') or coalesce(p_lot_multiplier, 0) <= 0
    or coalesce(p_max_lot, 0) <= 0 or (p_sizing_mode = 'fixed_lot' and coalesce(p_fixed_lot, 0) <= 0)
    or jsonb_typeof(coalesce(p_symbol_map, '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid social copy risk settings' using errcode = '22023';
  end if;

  insert into public.social_copy_subscriptions (
    source_id, source_trader_user_id, subscriber_user_id, destination_broker_account_id,
    sizing_mode, fixed_lot, lot_multiplier, max_lot, max_daily_loss,
    requested_account_mode, symbol_map
  ) values (
    p_source_id, v_source.trader_user_id, v_actor, p_destination_broker_account_id,
    p_sizing_mode, case when p_sizing_mode = 'fixed_lot' then p_fixed_lot else null end,
    p_lot_multiplier, p_max_lot, p_max_daily_loss, p_requested_account_mode, coalesce(p_symbol_map, '{}'::jsonb)
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A current subscription already exists for this source and destination' using errcode = '23505';
end;
$$;

create or replace function public.set_social_copy_subscription_status(p_subscription_id uuid, p_action text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if p_action not in ('pause', 'resume', 'stop', 'emergency_stop') then
    raise exception 'Invalid subscription action' using errcode = '22023';
  end if;
  update public.social_copy_subscriptions set
    desired_status = case when p_action = 'resume' then 'active' when p_action = 'pause' then 'paused' else 'stopped' end,
    status = 'pending',
    error_code = case when p_action = 'emergency_stop' then 'EMERGENCY_STOP_REQUESTED' else null end,
    error_detail = case when p_action = 'emergency_stop' then 'Emergency liquidation is awaiting worker acknowledgement' else null end,
    stopped_at = case when p_action in ('stop', 'emergency_stop') then now() else stopped_at end
  where id = p_subscription_id and subscriber_user_id = v_actor
    and (status not in ('stopped', 'emergency_stopped') or p_action = 'emergency_stop');
  if not found then raise exception 'Current subscription was not found' using errcode = 'P0002'; end if;
end;
$$;
create or replace function public.check_social_copy_subscription_authorization(p_subscription_id uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select case when current_user in ('service_role', 'postgres') then exists (
    select 1
    from public.social_copy_subscriptions s
    join public.social_copy_sources src on src.id = s.source_id
    join public.social_profiles sp on sp.user_id = src.trader_user_id
    join public.broker_accounts source_account on source_account.id = src.broker_account_id
    join public.broker_accounts destination_account on destination_account.id = s.destination_broker_account_id
    where s.id = p_subscription_id
      and src.status = 'published' and sp.is_listed = true
      and source_account.user_id = src.trader_user_id
      and destination_account.user_id = s.subscriber_user_id
      and (
        sp.access_mode = 'open'
        or exists (select 1 from public.social_follow_relationships r
          where r.follower_user_id = s.subscriber_user_id
            and r.followed_user_id = src.trader_user_id
            and r.status = 'accepted')
      )
  ) else false end;
$$;


-- A short service-role lease prevents two worker replicas reconciling the same subscription.
create or replace function public.claim_social_copy_subscriptions(p_worker text, p_limit integer default 20, p_lease_seconds integer default 30)
returns setof public.social_copy_subscriptions
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  return query
  with candidates as (
    select s.id from public.social_copy_subscriptions s
    where s.status not in ('stopped', 'emergency_stopped')
      and (s.lease_expires_at is null or s.lease_expires_at < now() or s.lease_owner = p_worker)
    order by coalesce(s.last_reconciled_at, s.created_at), s.id
    for update skip locked limit greatest(1, least(p_limit, 100))
  )
  update public.social_copy_subscriptions s set
    lease_owner = p_worker,
    lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300)))
  from candidates c where s.id = c.id returning s.*;
end;
$$;

revoke all on function public.set_social_copy_updated_at() from public, anon, authenticated;
revoke all on function public.publish_social_copy_source(uuid, text) from public, anon;
revoke all on function public.set_social_copy_source_status(uuid, text) from public, anon;
revoke all on function public.get_social_copy_sources(uuid) from public, anon;
revoke all on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb) from public, anon;
revoke all on function public.set_social_copy_subscription_status(uuid, text) from public, anon;
revoke all on function public.claim_social_copy_subscriptions(text, integer, integer) from public, anon, authenticated;
grant execute on function public.publish_social_copy_source(uuid, text) to authenticated;
grant execute on function public.set_social_copy_source_status(uuid, text) to authenticated;
revoke all on function public.check_social_copy_subscription_authorization(uuid) from public, anon, authenticated;
grant execute on function public.get_social_copy_sources(uuid) to authenticated;
grant execute on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb) to authenticated;
grant execute on function public.set_social_copy_subscription_status(uuid, text) to authenticated;
grant execute on function public.claim_social_copy_subscriptions(text, integer, integer) to service_role;
grant execute on function public.check_social_copy_subscription_authorization(uuid) to service_role;
