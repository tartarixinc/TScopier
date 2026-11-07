-- Persist configure-style Symbols + Filters on social copy subscriptions.

alter table public.social_copy_subscriptions
  add column if not exists manual_settings jsonb not null default '{}'::jsonb;

alter table public.social_copy_subscriptions
  drop constraint if exists social_copy_subscriptions_manual_settings_object;
alter table public.social_copy_subscriptions
  add constraint social_copy_subscriptions_manual_settings_object
  check (jsonb_typeof(manual_settings) = 'object');

comment on column public.social_copy_subscriptions.manual_settings is
  'Subscriber Symbols + Filters settings (symbol allow/avoid, schedule, news). Sizing stays in dedicated columns.';

create or replace function public.normalize_social_copy_manual_settings(p_settings jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v jsonb := coalesce(p_settings, '{}'::jsonb);
  v_exclude jsonb := '[]'::jsonb;
  v_days jsonb := '[]'::jsonb;
  v_impacts jsonb := '[]'::jsonb;
  v_item text;
  v_day integer;
  v_impact text;
  v_out jsonb;
begin
  if jsonb_typeof(v) <> 'object' then
    raise exception 'manual_settings must be a JSON object' using errcode = '22023';
  end if;

  if v ? 'symbols_exclude' and jsonb_typeof(v->'symbols_exclude') = 'array' then
    for v_item in
      select upper(trim(value))
      from jsonb_array_elements_text(v->'symbols_exclude') as t(value)
    loop
      if v_item <> '' then
        v_exclude := v_exclude || to_jsonb(v_item);
      end if;
    end loop;
  end if;

  if v ? 'trade_days' and jsonb_typeof(v->'trade_days') = 'array' then
    for v_day in
      select (value)::integer
      from jsonb_array_elements_text(v->'trade_days') as t(value)
      where value ~ '^[0-6]$'
    loop
      v_days := v_days || to_jsonb(v_day);
    end loop;
  end if;

  if v ? 'news_avoid_impacts' and jsonb_typeof(v->'news_avoid_impacts') = 'array' then
    for v_impact in
      select value
      from jsonb_array_elements_text(v->'news_avoid_impacts') as t(value)
      where value in ('high', 'medium', 'low')
    loop
      v_impacts := v_impacts || to_jsonb(v_impact);
    end loop;
  end if;

  v_out := jsonb_build_object(
    'symbol_to_trade', case
      when nullif(trim(coalesce(v->>'symbol_to_trade', '')), '') is null then null
      else trim(v->>'symbol_to_trade')
    end,
    'symbols_exclude', coalesce(v_exclude, '[]'::jsonb),
    'time_filter_enabled', coalesce((v->>'time_filter_enabled')::boolean, false),
    'trade_start_time', coalesce(nullif(trim(coalesce(v->>'trade_start_time', '')), ''), '00:00'),
    'trade_end_time', coalesce(nullif(trim(coalesce(v->>'trade_end_time', '')), ''), '23:59'),
    'days_filter_enabled', coalesce((v->>'days_filter_enabled')::boolean, false),
    'trade_days', case when jsonb_array_length(v_days) > 0 then v_days else '[1,2,3,4,5]'::jsonb end,
    'news_trading_enabled', coalesce((v->>'news_trading_enabled')::boolean, true),
    'allow_high_impact_news', coalesce((v->>'news_trading_enabled')::boolean, true),
    'news_avoid_impacts', case when jsonb_array_length(v_impacts) > 0 then v_impacts else '["high"]'::jsonb end,
    'close_before_news_minutes', greatest(0, least(24 * 60, coalesce((v->>'close_before_news_minutes')::integer, 30))),
    'resume_after_news_minutes', greatest(0, least(24 * 60, coalesce((v->>'resume_after_news_minutes')::integer, 15)))
  );
  return v_out;
end;
$$;

revoke all on function public.normalize_social_copy_manual_settings(jsonb) from public, anon;
grant execute on function public.normalize_social_copy_manual_settings(jsonb) to authenticated, service_role;

drop function if exists public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb);

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
  v_access text;
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
    sp.access_mode as access_mode,
    (s.is_synthetic = true or sp.is_synthetic_demo = true) as is_synthetic
  into v_source_selection
  from public.social_copy_sources s
  join public.social_profiles sp on sp.user_id = s.trader_user_id
  cross join lateral public.social_source_performance_eligibility(s.id) eligibility
  where s.id = p_source_id and s.status = 'published' and sp.is_listed = true
    and eligibility.eligible = true;
  if not found then raise exception 'Social copy source is unavailable or ineligible' using errcode = 'P0002'; end if;
  v_source := v_source_selection.source;
  v_access := v_source_selection.access_mode;
  v_source_synthetic := v_source_selection.is_synthetic;
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

create or replace function public.update_social_copy_subscription_settings(
  p_subscription_id uuid,
  p_sizing_mode text,
  p_fixed_lot numeric,
  p_lot_multiplier numeric,
  p_max_lot numeric,
  p_manual_settings jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_row public.social_copy_subscriptions%rowtype;
  v_manual jsonb;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  select * into v_row
  from public.social_copy_subscriptions
  where id = p_subscription_id
  for update;
  if not found then raise exception 'Subscription not found' using errcode = 'P0002'; end if;
  if v_row.subscriber_user_id is distinct from v_actor then
    raise exception 'Not authorized to update this subscription' using errcode = '42501';
  end if;
  if v_row.status in ('stopped', 'emergency_stopped') or v_row.desired_status = 'stopped' then
    raise exception 'Stopped subscriptions cannot be updated' using errcode = '55000';
  end if;

  if p_sizing_mode not in ('fixed_lot', 'lot_multiplier', 'equity_ratio')
    or coalesce(p_lot_multiplier, 0) <= 0 or coalesce(p_lot_multiplier, 0) > 100
    or coalesce(p_max_lot, 0) <= 0 or coalesce(p_max_lot, 0) > 1000
    or (p_sizing_mode = 'fixed_lot' and (coalesce(p_fixed_lot, 0) <= 0 or p_fixed_lot > p_max_lot)) then
    raise exception 'Invalid social copy risk settings' using errcode = '22023';
  end if;

  v_manual := public.normalize_social_copy_manual_settings(p_manual_settings);

  update public.social_copy_subscriptions set
    sizing_mode = p_sizing_mode,
    fixed_lot = case when p_sizing_mode = 'fixed_lot' then p_fixed_lot else null end,
    lot_multiplier = p_lot_multiplier,
    max_lot = p_max_lot,
    manual_settings = v_manual,
    updated_at = now()
  where id = p_subscription_id;
end;
$$;

revoke all on function public.update_social_copy_subscription_settings(uuid, text, numeric, numeric, numeric, jsonb)
  from public, anon;
grant execute on function public.update_social_copy_subscription_settings(uuid, text, numeric, numeric, numeric, jsonb)
  to authenticated;
