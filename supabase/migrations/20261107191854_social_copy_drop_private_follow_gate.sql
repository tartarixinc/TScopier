-- Allow copying private traders without an accepted follow relationship.

create or replace function public.create_social_copy_subscription(
  p_source_id uuid,
  p_destination_broker_account_id uuid,
  p_sizing_mode text,
  p_fixed_lot numeric,
  p_lot_multiplier numeric,
  p_max_lot numeric,
  p_max_daily_loss numeric default null,
  p_requested_account_mode text default 'demo',
  p_symbol_map jsonb default '{}'::jsonb,
  p_manual_settings jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_source public.social_copy_sources%rowtype;
  v_source_selection record;
  v_source_mode text;
  v_destination_mode text;
  v_source_synthetic boolean := false;
  v_subscriber_synthetic boolean := false;
  v_execution_path text := 'broker';
  v_manual jsonb;
  v_id uuid;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_profile_is_eligible(v_actor) then
    raise exception 'Join the social directory before copying a trader' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.social_copy_sources s
    join public.social_profiles sp
      on sp.user_id = s.trader_user_id
    cross join lateral
      public.social_source_performance_eligibility(s.id) eligibility
    where s.id = p_source_id
      and s.status = 'published'
      and sp.is_listed = true
      and eligibility.reason = 'history_stale'
      and (
        sp.access_mode = 'open'
        or s.trader_user_id = v_actor
        or exists (
          select 1
          from public.social_follow_relationships r
          where r.follower_user_id = v_actor
            and r.followed_user_id = s.trader_user_id
            and r.status = 'accepted'
        )
      )
  ) then
    raise exception 'Provider is not eligible for copying: history_stale'
      using errcode = '55000';
  end if;

  select
    s as source,
    (s.is_synthetic = true or sp.is_synthetic_demo = true) as is_synthetic
  into v_source_selection
  from public.social_copy_sources s
  join public.social_profiles sp on sp.user_id = s.trader_user_id
  cross join lateral public.social_source_performance_eligibility(s.id) eligibility
  where s.id = p_source_id and s.status = 'published' and sp.is_listed = true
    and eligibility.eligible = true;
  if not found then raise exception 'Social copy source is unavailable or ineligible' using errcode = 'P0002'; end if;
  v_source := v_source_selection.source;
  v_source_synthetic := v_source_selection.is_synthetic;
  if v_source.trader_user_id = v_actor then raise exception 'Users cannot copy themselves' using errcode = '23514'; end if;

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

  v_manual := public.normalize_social_copy_manual_settings(p_manual_settings);

  insert into public.social_copy_subscriptions (
    source_id, source_trader_user_id, subscriber_user_id, destination_broker_account_id,
    sizing_mode, fixed_lot, lot_multiplier, max_lot, max_daily_loss,
    requested_account_mode, source_account_mode, destination_account_mode,
    execution_path, symbol_map, manual_settings
  ) values (
    p_source_id, v_source.trader_user_id, v_actor, p_destination_broker_account_id,
    p_sizing_mode, case when p_sizing_mode = 'fixed_lot' then p_fixed_lot else null end,
    p_lot_multiplier, p_max_lot, p_max_daily_loss,
    v_destination_mode, v_source_mode, v_destination_mode,
    v_execution_path, coalesce(p_symbol_map, '{}'::jsonb), v_manual
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A current subscription already exists for this source and destination' using errcode = '23505';
end;
$$;

revoke all on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb, jsonb)
  to authenticated;
