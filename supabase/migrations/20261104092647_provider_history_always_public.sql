-- Approved providers' source-account information is public.
--
-- The "can this viewer see this trader's history" rule was copied into several places
-- (get_social_trade_history_access, get_social_provider_performance, get_social_copy_sources,
-- provider_public_shared_source) and every copy also required the legacy per-profile
-- `share_trade_history` toggle and/or `access_mode = 'open'`. A provider whose toggle was off
-- (or whose profile was private) therefore showed
-- "This trader has not shared source-account history with you." even though approved providers
-- are public by definition.
--
-- This migration keeps ONE rule (social_history_viewable), points every gate at it, and makes
-- `share_trade_history` follow provider approval so the two can no longer disagree.

-- 1. Single visibility rule.
create or replace function public.social_history_viewable(p_trader_user_id uuid, p_viewer_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.social_profiles sp
    where sp.user_id = p_trader_user_id
      and sp.is_listed = true
      and (
        p_viewer_user_id = p_trader_user_id
        or sp.provider_status = 'approved'
        or (
          sp.share_trade_history
          and (
            sp.access_mode = 'open'
            or exists (
              select 1 from public.social_follow_relationships r
              where r.follower_user_id = p_viewer_user_id
                and r.followed_user_id = p_trader_user_id
                and r.status = 'accepted'
            )
          )
        )
      )
  );
$$;

revoke all on function public.social_history_viewable(uuid, uuid) from public, anon, authenticated;

-- 2. Access check used by the client and by get_social_source_trade_history.
create or replace function public.get_social_trade_history_access(p_trader_user_id uuid)
returns table (sharing_enabled boolean, can_view boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare v_actor uuid := auth.uid(); v_profile public.social_profiles%rowtype;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_profile from public.social_profiles
  where user_id = p_trader_user_id and is_listed = true;
  if not found then raise exception 'Social profile is not available' using errcode = 'P0002'; end if;
  return query select
    (v_profile.share_trade_history or v_profile.provider_status = 'approved'),
    public.social_history_viewable(p_trader_user_id, v_actor);
end;
$$;

revoke all on function public.get_social_trade_history_access(uuid) from public, anon;
grant execute on function public.get_social_trade_history_access(uuid) to authenticated;

-- 3. Performance RPC: same body as 20261101164716, gate replaced by the single rule.
create or replace function public.get_social_provider_performance(p_trader_user_id uuid)
returns table (
  source_id uuid,
  source_label text,
  source_status text,
  performance_status text,
  status_reason text,
  account_mode text,
  currency text,
  period_started_at timestamptz,
  period_ended_at timestamptz,
  last_sync_succeeded_at timestamptz,
  calculated_at timestamptz,
  history_complete boolean,
  open_trade_count bigint,
  closed_trade_count bigint,
  realized_profit numeric,
  win_rate numeric,
  profit_factor numeric,
  return_percentage numeric,
  maximum_drawdown numeric,
  equity_curve_available boolean,
  is_copy_eligible boolean,
  eligibility_reason text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.social_profiles
    where user_id = p_trader_user_id and is_listed = true
  ) then
    raise exception 'Social profile is not available' using errcode = 'P0002';
  end if;

  if not public.social_history_viewable(p_trader_user_id, v_actor) then
    raise exception 'Trader has not shared trade history with this viewer' using errcode = '42501';
  end if;

  return query
  with source_context as (
    select s.id, coalesce(nullif(btrim(s.label), ''), 'Copy source') as label,
      s.status, s.broker_account_id,
      lower(coalesce(nullif(b.provider, ''), 'fxsocket')) as provider,
      upper(coalesce(b.platform, '')) as platform,
      b.is_active,
      lower(coalesce(b.connection_status, '')) as connection_status,
      coalesce(public.social_broker_account_mode(b.id), 'unknown') as normalized_account_mode,
      b.last_currency, b.last_synced_at
    from public.social_copy_sources s
    left join public.broker_accounts b
      on b.id = s.broker_account_id and b.user_id = s.trader_user_id
    where s.trader_user_id = p_trader_user_id
      and (s.status = 'published' or v_actor = p_trader_user_id)
  ), evaluated as (
    select sc.*, f.*,
      case
        when sc.broker_account_id is null then 'unavailable'
        when sc.provider not in ('fxsocket', 'mtapi') or sc.platform not in ('MT4', 'MT5') then 'unavailable'
        when sc.connection_status = 'error' then 'failed'
        when not sc.is_active or sc.connection_status not in ('connected', 'healthy') then 'unavailable'
        when sc.last_synced_at is null then 'pending'
        when sc.last_synced_at < now() - interval '15 minutes' then 'stale'
        when coalesce(f.incomplete_count, 0) > 0 then 'incomplete'
        when coalesce(f.open_count, 0) + coalesce(f.closed_count, 0) = 0 then 'no_history'
        else 'available'
      end as performance_state,
      case
        when sc.broker_account_id is null then 'source_account_missing'
        when sc.provider not in ('fxsocket', 'mtapi') or sc.platform not in ('MT4', 'MT5') then 'source_unsupported'
        when sc.connection_status = 'error' then 'sync_failed'
        when not sc.is_active then 'source_inactive'
        when sc.connection_status not in ('connected', 'healthy') then 'source_disconnected'
        when sc.last_synced_at is null then 'sync_pending'
        when sc.last_synced_at < now() - interval '15 minutes' then 'history_stale'
        when coalesce(f.incomplete_count, 0) > 0 then 'history_incomplete'
        when coalesce(f.open_count, 0) + coalesce(f.closed_count, 0) = 0 then 'no_history'
        else 'current'
      end as performance_reason
    from source_context sc
    cross join lateral public.social_source_trade_facts(sc.id) f
  )
  select
    e.id,
    e.label,
    e.status,
    e.performance_state,
    e.performance_reason,
    case when e.normalized_account_mode = 'demo' then 'demo'
         when e.normalized_account_mode = 'unknown' then 'unknown' else 'live' end,
    nullif(btrim(e.last_currency), ''),
    e.period_start,
    e.period_end,
    e.last_synced_at,
    statement_timestamp(),
    coalesce(e.closed_count, 0) > 0 and coalesce(e.incomplete_count, 0) = 0,
    e.open_count,
    e.closed_count,
    e.realized_profit,
    case when coalesce(e.verified_closed_count, 0) > 0
      then round((e.wins::numeric / e.verified_closed_count::numeric) * 100, 2)
      else null end,
    case when e.gross_loss > 0
      then round(coalesce(e.gross_profit, 0) / e.gross_loss, 4) else null end,
    case when coalesce(e.closed_count, 0) > 0 and coalesce(e.incomplete_count, 0) = 0 then rm.return_percentage end,
    case when coalesce(e.closed_count, 0) > 0 and coalesce(e.incomplete_count, 0) = 0 then rm.max_drawdown end,
    false,
    eligibility.eligible,
    eligibility.reason
  from evaluated e
  cross join lateral public.social_source_performance_eligibility(e.id) eligibility
  cross join lateral public.social_source_return_metrics(e.id) rm
  order by (e.status = 'published') desc, e.label, e.id;
end;
$$;

revoke all on function public.get_social_provider_performance(uuid) from public, anon;
grant execute on function public.get_social_provider_performance(uuid) to authenticated;

-- 4. Copy-source list: approved providers' sources are listed to every signed-in viewer.
create or replace function public.get_social_copy_sources(p_trader_user_id uuid)
returns table (
  source_id uuid, label text, provider text, platform text, account_hint text, account_mode text,
  connection_healthy boolean, is_copy_eligible boolean, eligibility_reason text, is_synthetic boolean,
  eligibility_diagnostics jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.id, coalesce(s.label, 'Copy source'), coalesce(b.provider, 'fxsocket'), b.platform,
    case when nullif(btrim(b.account_login), '') is null then 'Identifier unavailable'
      else repeat(chr(8226), 4) || right(btrim(b.account_login), 4) end,
    coalesce(public.social_broker_account_mode(b.id), 'unknown'),
    (b.is_active = true and lower(coalesce(b.connection_status, '')) in ('connected', 'healthy')),
    eligibility.eligible, eligibility.reason, (s.is_synthetic = true or sp.is_synthetic_demo = true),
    public.social_source_eligibility_diagnostics(s.id)
  from public.social_copy_sources s
  join public.broker_accounts b on b.id = s.broker_account_id and b.user_id = s.trader_user_id
  join public.social_profiles sp on sp.user_id = s.trader_user_id and sp.is_listed = true
  cross join lateral public.social_source_performance_eligibility(s.id) eligibility
  where s.trader_user_id = p_trader_user_id and s.status = 'published'
    and (sp.provider_status = 'approved' or sp.access_mode = 'open' or s.trader_user_id = auth.uid() or exists (
      select 1 from public.social_follow_relationships r where r.follower_user_id = auth.uid()
        and r.followed_user_id = s.trader_user_id and r.status = 'accepted'))
  order by s.created_at, s.id;
$$;

revoke all on function public.get_social_copy_sources(uuid) from public, anon;
grant execute on function public.get_social_copy_sources(uuid) to authenticated;

-- 5. Public /p/{slug} page: an approved provider is always shared (no second toggle).
create or replace function public.provider_public_shared_source(p_slug text)
returns table (source_id uuid, trader_user_id uuid, shared boolean, broker_account_id uuid, currency text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select src.id, sp.user_id, true, src.broker_account_id, src.snapshot_currency
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  left join lateral (
    select s.id, s.broker_account_id, s.snapshot_currency
    from public.social_copy_sources s
    where s.trader_user_id = sp.user_id and s.status = 'published'
    order by s.created_at asc
    limit 1
  ) src on true
  where sp.slug = lower(btrim(p_slug))
    and sp.is_listed = true
    and sp.provider_status = 'approved'
    and sp.is_synthetic_demo = false
    and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
$$;

revoke all on function public.provider_public_shared_source(text) from public, anon, authenticated;

-- 6. share_trade_history can no longer disagree with provider approval.
create or replace function public.social_profiles_force_provider_sharing()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.provider_status = 'approved' then
    new.share_trade_history := true;
  end if;
  return new;
end;
$$;

drop trigger if exists social_profiles_force_provider_sharing on public.social_profiles;
create trigger social_profiles_force_provider_sharing
  before insert or update of provider_status, share_trade_history on public.social_profiles
  for each row execute function public.social_profiles_force_provider_sharing();

update public.social_profiles
set share_trade_history = true
where provider_status = 'approved' and share_trade_history is distinct from true;

create or replace function public.set_social_trade_history_sharing(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not coalesce(p_enabled, false) and exists (
    select 1 from public.social_profiles where user_id = v_actor and provider_status = 'approved'
  ) then
    raise exception 'Approved providers always share their source-account history' using errcode = '42501';
  end if;
  update public.social_profiles set share_trade_history = coalesce(p_enabled, false)
  where user_id = v_actor and is_listed = true;
  if not found then raise exception 'Social profile is not registered' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.set_social_trade_history_sharing(boolean) from public, anon;
grant execute on function public.set_social_trade_history_sharing(boolean) to authenticated;
