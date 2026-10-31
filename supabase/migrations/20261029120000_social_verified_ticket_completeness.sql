-- Keep unverified trade rows visible to integrity checks while limiting public
-- metrics and history to broker-verified identities.

-- Provider-aware canonical identity contract. MetaTrader bridges accept only
-- positive JavaScript-safe integers and collapse leading zeroes. Providers
-- whose native contract permits opaque strings retain their trimmed value.
-- Existing rows are deliberately not rewritten; reads/deduplication normalize
-- them so historical identities remain intact while new worker writes are canonical.
create or replace function public.social_normalize_trade_ticket(p_provider text, p_ticket text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select case
    when lower(coalesce(nullif(btrim(p_provider), ''), 'fxsocket')) in ('fxsocket', 'mtapi') then
      case when p_ticket ~ '^[0-9]+$'
             and p_ticket::numeric between 1 and 9007199254740991
        then (p_ticket::numeric)::text else null end
    when lower(btrim(p_provider)) in ('ctrader', 'binance', 'bybit', 'kucoin', 'dxtrade', 'tradelocker', 'matchtrader')
         and length(btrim(coalesce(p_ticket, ''))) between 1 and 255
         and btrim(p_ticket) !~ '[[:cntrl:]]'
      then btrim(p_ticket)
    else null
  end;
$$;

create or replace function public.social_trade_ticket_is_verified(p_provider text, p_ticket text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select public.social_normalize_trade_ticket(p_provider, p_ticket) is not null;
$$;

create or replace function public.social_trade_ticket_is_verified(p_ticket text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select public.social_trade_ticket_is_verified('fxsocket', p_ticket);
$$;

revoke all on function public.social_normalize_trade_ticket(text, text), public.social_trade_ticket_is_verified(text, text), public.social_trade_ticket_is_verified(text)
  from public, anon, authenticated;
grant execute on function public.social_normalize_trade_ticket(text, text), public.social_trade_ticket_is_verified(text, text), public.social_trade_ticket_is_verified(text)
  to service_role;

create or replace function public.social_source_trade_facts(p_source_id uuid)
returns table (
  open_count bigint,
  closed_count bigint,
  incomplete_count bigint,
  verified_closed_count bigint,
  period_start timestamptz,
  period_end timestamptz,
  realized_profit numeric,
  wins bigint,
  gross_profit numeric,
  gross_loss numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with source_context as (
    select s.broker_account_id
    from public.social_copy_sources s
    join public.broker_accounts b
      on b.id = s.broker_account_id and b.user_id = s.trader_user_id
    where s.id = p_source_id
  ), scoped as (
    select distinct on (
      case when public.social_trade_ticket_is_verified(t.metaapi_order_id)
        then 'ticket:' || public.social_normalize_trade_ticket('fxsocket', t.metaapi_order_id) else 'row:' || t.id::text end
    )
      t.id,
      t.metaapi_order_id,
      lower(t.status) as status,
      t.opened_at,
      t.closed_at,
      t.profit,
      t.created_at
    from source_context sc
    join public.trades t on t.broker_account_id = sc.broker_account_id
    where (lower(t.status) = 'open'
       or t.closed_at is not null
       or lower(t.status) = 'closed')
      and not exists (
        select 1
        from public.social_copy_subscriptions sub
        join public.social_copy_trade_mappings mapping on mapping.subscription_id = sub.id
        where sub.destination_broker_account_id = t.broker_account_id
          and mapping.destination_ticket is not null
          and mapping.destination_ticket = t.metaapi_order_id
      )
    order by
      case when public.social_trade_ticket_is_verified(t.metaapi_order_id)
        then 'ticket:' || public.social_normalize_trade_ticket('fxsocket', t.metaapi_order_id) else 'row:' || t.id::text end,
      t.created_at desc,
      t.id desc
  )
  select
    count(*) filter (
      where status = 'open' and closed_at is null
        and public.social_trade_ticket_is_verified(metaapi_order_id)
    ),
    count(*) filter (where status = 'closed' or closed_at is not null),
    count(*) filter (
      where not public.social_trade_ticket_is_verified(metaapi_order_id)
        or (
          (status = 'closed' or closed_at is not null)
          and (profit is null or closed_at is null)
        )
    ),
    count(*) filter (
      where (status = 'closed' or closed_at is not null)
        and public.social_trade_ticket_is_verified(metaapi_order_id)
        and profit is not null
    ),
    min(opened_at) filter (
      where (status = 'closed' or closed_at is not null)
        and public.social_trade_ticket_is_verified(metaapi_order_id)
        and profit is not null
    ),
    max(closed_at) filter (
      where (status = 'closed' or closed_at is not null)
        and public.social_trade_ticket_is_verified(metaapi_order_id)
        and profit is not null
    ),
    sum(profit) filter (
      where (status = 'closed' or closed_at is not null)
        and public.social_trade_ticket_is_verified(metaapi_order_id)
        and profit is not null
    ),
    count(*) filter (
      where (status = 'closed' or closed_at is not null)
        and public.social_trade_ticket_is_verified(metaapi_order_id)
        and profit is not null and profit > 0
    ),
    sum(profit) filter (
      where (status = 'closed' or closed_at is not null)
        and public.social_trade_ticket_is_verified(metaapi_order_id)
        and profit is not null and profit > 0
    ),
    abs(sum(profit) filter (
      where (status = 'closed' or closed_at is not null)
        and public.social_trade_ticket_is_verified(metaapi_order_id)
        and profit is not null and profit < 0
    ))
  from scoped;
$$;

revoke all on function public.social_source_trade_facts(uuid)
  from public, anon, authenticated;
grant execute on function public.social_source_trade_facts(uuid)
  to service_role;

create or replace function public.social_source_performance_eligibility(p_source_id uuid)
returns table (eligible boolean, reason text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with source_context as (
    select s.id, s.status, s.is_synthetic, sp.is_synthetic_demo,
      lower(coalesce(nullif(b.provider, ''), 'fxsocket')) as provider,
      upper(coalesce(b.platform, '')) as platform,
      b.is_active,
      lower(coalesce(b.connection_status, '')) as connection_status,
      coalesce(public.social_broker_account_mode(b.id), 'unknown') as account_mode,
      b.last_synced_at
    from public.social_copy_sources s
    join public.broker_accounts b
      on b.id = s.broker_account_id and b.user_id = s.trader_user_id
    join public.social_profiles sp on sp.user_id = s.trader_user_id
    where s.id = p_source_id
  ), evaluated as (
    select sc.*, f.*
    from (select 1) seed
    left join source_context sc on true
    left join lateral public.social_source_trade_facts(p_source_id) f on true
  )
  select
    case
      when id is null then false
      when status <> 'published' then false
      when (is_synthetic or is_synthetic_demo)
        and not public.social_copy_synthetic_participants_enabled() then false
      when provider not in ('fxsocket', 'mtapi') or platform not in ('MT4', 'MT5') then false
      when account_mode not in ('demo', 'live') then false
      when not is_active or connection_status not in ('connected', 'healthy') then false
      when last_synced_at is null or last_synced_at < now() - interval '15 minutes' then false
      when coalesce(incomplete_count, 0) > 0 then false
      when coalesce(verified_closed_count, 0) < 10 then false
      when period_start is null or period_end is null
        or period_end - period_start < interval '7 days' then false
      else true
    end,
    case
      when id is null then 'source_missing'
      when status <> 'published' then 'source_not_published'
      when (is_synthetic or is_synthetic_demo)
        and not public.social_copy_synthetic_participants_enabled() then 'synthetic_preview_disabled'
      when provider not in ('fxsocket', 'mtapi') or platform not in ('MT4', 'MT5') then 'source_unsupported'
      when account_mode not in ('demo', 'live') then 'account_mode_unknown'
      when not is_active then 'source_inactive'
      when connection_status = 'error' then 'sync_failed'
      when connection_status not in ('connected', 'healthy') then 'source_disconnected'
      when last_synced_at is null then 'sync_pending'
      when last_synced_at < now() - interval '15 minutes' then 'history_stale'
      when coalesce(incomplete_count, 0) > 0 then 'history_incomplete'
      when coalesce(verified_closed_count, 0) < 10 then 'minimum_trades_not_met'
      when period_start is null or period_end is null
        or period_end - period_start < interval '7 days' then 'minimum_period_not_met'
      else 'eligible'
    end
  from evaluated;
$$;

revoke all on function public.social_source_performance_eligibility(uuid)
  from public, anon, authenticated;
grant execute on function public.social_source_performance_eligibility(uuid)
  to service_role;

comment on function public.social_source_performance_eligibility(uuid) is
  'Requires complete source history including unresolved closed rows and at least 10 verified closed trades spanning 7 days.';

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
  v_profile public.social_profiles%rowtype;
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_profile
  from public.social_profiles
  where user_id = p_trader_user_id and is_listed = true;
  if not found then
    raise exception 'Social profile is not available' using errcode = 'P0002';
  end if;

  if v_actor <> p_trader_user_id and not (
    v_profile.share_trade_history
    and (
      v_profile.access_mode = 'open'
      or exists (
        select 1 from public.social_follow_relationships r
        where r.follower_user_id = v_actor
          and r.followed_user_id = p_trader_user_id
          and r.status = 'accepted'
      )
    )
  ) then
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
    null::numeric,
    null::numeric,
    false,
    eligibility.eligible,
    eligibility.reason
  from evaluated e
  cross join lateral public.social_source_performance_eligibility(e.id) eligibility
  order by (e.status = 'published') desc, e.label, e.id;
end;
$$;

revoke all on function public.get_social_provider_performance(uuid)
  from public, anon;
grant execute on function public.get_social_provider_performance(uuid)
  to authenticated;

create or replace function public.get_social_source_trade_history(
  p_source_id uuid,
  p_limit integer default 100
)
returns table (
  trade_id uuid,
  symbol text,
  direction text,
  trade_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  realized_profit numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_source public.social_copy_sources%rowtype;
  v_access record;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_source from public.social_copy_sources where id = p_source_id;
  if not found then raise exception 'Published source is not available' using errcode = 'P0002'; end if;

  select * into v_access
  from public.get_social_trade_history_access(v_source.trader_user_id);
  if not coalesce(v_access.can_view, false) then
    raise exception 'Trader has not shared trade history with this viewer' using errcode = '42501';
  end if;
  if v_actor <> v_source.trader_user_id and v_source.status <> 'published' then
    raise exception 'Published source is not available' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.broker_accounts b
    where b.id = v_source.broker_account_id and b.user_id = v_source.trader_user_id
  ) then
    raise exception 'Source account is unavailable' using errcode = 'P0002';
  end if;

  return query
  with scoped as (
    select distinct on (public.social_normalize_trade_ticket('fxsocket', t.metaapi_order_id)) t.*
    from public.trades t
    where t.broker_account_id = v_source.broker_account_id
      and (lower(t.status) = 'open' or t.closed_at is not null or lower(t.status) = 'closed')
      and public.social_trade_ticket_is_verified(t.metaapi_order_id)
      and not exists (
        select 1
        from public.social_copy_subscriptions sub
        join public.social_copy_trade_mappings mapping on mapping.subscription_id = sub.id
        where sub.destination_broker_account_id = t.broker_account_id
          and mapping.destination_ticket is not null
          and mapping.destination_ticket = t.metaapi_order_id
      )
    order by public.social_normalize_trade_ticket('fxsocket', t.metaapi_order_id), t.created_at desc, t.id desc
  )
  select s.id, s.symbol, lower(s.direction),
    case when s.closed_at is not null or lower(s.status) = 'closed' then 'closed' else 'open' end,
    s.opened_at, s.closed_at,
    case when s.closed_at is not null or lower(s.status) = 'closed' then s.profit else null end
  from scoped s
  order by coalesce(s.closed_at, s.opened_at) desc, s.id
  limit greatest(1, least(coalesce(p_limit, 100), 250));
end;
$$;

revoke all on function public.get_social_source_trade_history(uuid, integer)
  from public, anon;
grant execute on function public.get_social_source_trade_history(uuid, integer)
  to authenticated;

create or replace function public.social_source_eligibility_diagnostics(p_source_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with source_context as (
    select s.id, s.status, s.broker_account_id, b.id as broker_record_id,
      s.is_synthetic, sp.is_synthetic_demo,
      lower(coalesce(nullif(b.provider, ''), 'fxsocket')) as provider,
      upper(coalesce(b.platform, '')) as platform, b.is_active,
      lower(coalesce(b.connection_status, '')) as connection_status,
      coalesce(public.social_broker_account_mode(b.id), 'unknown') as account_mode,
      b.last_synced_at
    from public.social_copy_sources s
    left join public.broker_accounts b on b.id = s.broker_account_id and b.user_id = s.trader_user_id
    left join public.social_profiles sp on sp.user_id = s.trader_user_id
    where s.id = p_source_id
  ), context as (
    select sc.*,
      coalesce(f.closed_count, 0) as closed_count,
      coalesce(f.incomplete_count, 0) as incomplete_count,
      coalesce(f.verified_closed_count, 0) as verified_closed_count,
      f.period_start, f.period_end
    from (select 1) seed
    left join source_context sc on true
    left join lateral public.social_source_trade_facts(p_source_id) f on true
  ), checks as (
    select v.*
    from context c
    cross join lateral (values
      (0, case when c.id is null or c.broker_record_id is null then 'source_missing' else 'source_present' end,
        case when c.id is null or c.broker_record_id is null then 'blocked' else 'passed' end,
        case when c.id is null or c.broker_record_id is null then 'error' else 'success' end,
        case when c.id is null or c.broker_record_id is null then 'The selected source account is unavailable.' else 'The source account exists and is owned by the publishing trader.' end,
        case when c.id is null or c.broker_record_id is null then 'Choose another owned source account or publish a new one.' else null end,
        c.id is null or c.broker_record_id is null),
      (1, case when c.status = 'published' then 'source_published' else 'source_not_published' end,
        case when c.status = 'published' then 'passed' else 'blocked' end,
        case when c.status = 'published' then 'success' else 'warning' end,
        case when c.status = 'published' then 'The trader explicitly published this source account.' else 'This source account has not been published for Social Trading.' end,
        case when c.status = 'published' then null else 'Publish this account from Social Trading settings.' end,
        c.status is distinct from 'published'),
      (2, case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'synthetic_preview_disabled' else 'synthetic_policy_passed' end,
        case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'blocked' else 'passed' end,
        case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'warning' else 'success' end,
        case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'This synthetic demo source is restricted to an isolated preview environment.' else 'The source passes the preview-only synthetic participation policy.' end,
        case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'Use Migration Preview with synthetic participation enabled, or select a genuine connected account.' else null end,
        coalesce((c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled(), false)),
      (3, case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then 'source_supported' else 'source_unsupported' end,
        case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then 'passed' else 'blocked' end,
        case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then 'success' else 'error' end,
        case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then 'The source provider and platform are supported.' else 'This broker provider or platform is not supported for verified Social Trading performance.' end,
        case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then null else 'Connect a supported FxSocket or MTAPI MT4/MT5 account.' end,
        coalesce(c.provider not in ('fxsocket', 'mtapi') or c.platform not in ('MT4', 'MT5'), true)),
      (4, case when c.account_mode in ('demo', 'live') then 'account_mode_verified' else 'account_mode_unknown' end,
        case when c.account_mode in ('demo', 'live') then 'passed' else 'pending' end,
        case when c.account_mode in ('demo', 'live') then 'success' else 'info' end,
        case when c.account_mode in ('demo', 'live') then 'The broker verified whether this is a demo or live account.' else 'The account demo/live mode has not been verified yet.' end,
        case when c.account_mode in ('demo', 'live') then null else 'Reconnect or synchronize the account so its mode can be verified.' end,
        coalesce(c.account_mode not in ('demo', 'live'), true)),
      (5, case when c.is_active then 'source_active' else 'source_inactive' end,
        case when c.is_active then 'passed' else 'blocked' end,
        case when c.is_active then 'success' else 'error' end,
        case when c.is_active then 'The source account is active.' else 'The source account is inactive.' end,
        case when c.is_active then null else 'Activate the broker connection before using it as a source.' end,
        not coalesce(c.is_active, false)),
      (6, case when c.connection_status = 'error' then 'sync_failed' when c.connection_status not in ('connected', 'healthy') then 'source_disconnected' else 'source_connected' end,
        case when c.connection_status in ('connected', 'healthy') then 'passed' else 'blocked' end,
        case when c.connection_status in ('connected', 'healthy') then 'success' else 'error' end,
        case when c.connection_status = 'error' then 'The latest broker synchronization failed.' when c.connection_status not in ('connected', 'healthy') then 'The source account is disconnected from its broker.' else 'The source broker connection is healthy.' end,
        case when c.connection_status = 'error' then 'Repair or reconnect the broker account, then synchronize it again.' when c.connection_status not in ('connected', 'healthy') then 'Reconnect the source account and confirm that its connection is healthy.' else null end,
        coalesce(c.connection_status not in ('connected', 'healthy'), true)),
      (7, case when c.last_synced_at is null then 'sync_pending' when c.last_synced_at < now() - interval '15 minutes' then 'history_stale' else 'history_fresh' end,
        case when c.last_synced_at is null then 'pending' when c.last_synced_at < now() - interval '15 minutes' then 'blocked' else 'passed' end,
        case when c.last_synced_at is null then 'info' when c.last_synced_at < now() - interval '15 minutes' then 'error' else 'success' end,
        case when c.last_synced_at is null then 'The first successful source synchronization has not completed.' when c.last_synced_at < now() - interval '15 minutes' then 'The source history is older than the 15-minute freshness limit.' else 'The source history is within the 15-minute freshness limit.' end,
        case when c.last_synced_at is null then 'Keep the account connected and wait for synchronization to finish.' when c.last_synced_at < now() - interval '15 minutes' then 'Restore synchronization and wait for a fresh broker snapshot.' else null end,
        c.last_synced_at is null or c.last_synced_at < now() - interval '15 minutes'),
      (8, case when c.incomplete_count > 0 then 'history_incomplete' else 'history_complete' end,
        case when c.incomplete_count > 0 then 'blocked' else 'passed' end,
        case when c.incomplete_count > 0 then 'error' else 'success' end,
        case when c.incomplete_count > 0 then 'One or more source trades have an unverified broker ticket, or a closed trade is missing its close time or realized result.' else 'Every relevant source trade has a verified broker ticket, and every closed trade has a close time and realized result.' end,
        case when c.incomplete_count > 0 then 'Resolve or resynchronize every unresolved trade before publishing complete history.' else null end,
        c.incomplete_count > 0),
      (9, case when c.verified_closed_count < 10 then 'minimum_trades_not_met' else 'minimum_trades_met' end,
        case when c.verified_closed_count < 10 then 'pending' else 'passed' end,
        case when c.verified_closed_count < 10 then 'info' else 'success' end,
        case when c.verified_closed_count < 10 then 'Fewer than 10 closed trades with verified tickets and realized results are available.' else 'At least 10 closed trades with verified tickets and realized results are available.' end,
        case when c.verified_closed_count < 10 then 'Accumulate at least 10 verified closed trades and synchronize them.' else null end,
        c.verified_closed_count < 10),
      (10, case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'minimum_period_not_met' else 'minimum_period_met' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'pending' else 'passed' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'info' else 'success' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'The verified closed-trade history spans less than 7 days.' else 'The verified closed-trade history spans at least 7 days.' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'Keep the account synchronized until its verified closed-trade history spans at least 7 days.' else null end,
        c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days')
    ) as v(check_order, code, status, severity, explanation, next_action, blocking)
    where c.id is not null or v.check_order = 0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'order', check_order, 'code', code, 'status', status, 'severity', severity,
    'explanation', explanation, 'next_action', next_action, 'blocking', blocking
  ) order by check_order), '[]'::jsonb)
  from checks;
$$;

revoke all on function public.social_source_eligibility_diagnostics(uuid)
  from public, anon, authenticated;
grant execute on function public.social_source_eligibility_diagnostics(uuid)
  to service_role;
