-- Drop the 10-trade and incomplete-history copy gates, and always surface known
-- performance metrics (ROI / drawdown / status) from synced source trades.

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
      when period_start is null or period_end is null
        or period_end - period_start < interval '7 days' then 'minimum_period_not_met'
      else 'eligible'
    end
  from evaluated;
$$;

comment on function public.social_source_performance_eligibility(uuid) is
  'Requires a published, supported, fresh source whose verified closed-trade history spans at least 7 days. Incomplete rows and trade-count minimums are not blockers.';

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
    select * from (
      select
        0 as check_order,
        case when c.id is null or c.broker_record_id is null then 'source_missing' else 'source_present' end as code,
        case when c.id is null or c.broker_record_id is null then 'blocked' else 'passed' end as status,
        case when c.id is null or c.broker_record_id is null then 'error' else 'success' end as severity,
        case when c.id is null or c.broker_record_id is null then 'The selected source account is unavailable.' else 'The source account exists and is owned by the publishing trader.' end as explanation,
        case when c.id is null or c.broker_record_id is null then 'Choose another owned source account or publish a new one.' else null end as next_action,
        (c.id is null or c.broker_record_id is null) as blocking
      from context c
      union all
      select 1,
        case when c.status = 'published' then 'source_published' else 'source_not_published' end,
        case when c.status = 'published' then 'passed' else 'blocked' end,
        case when c.status = 'published' then 'success' else 'warning' end,
        case when c.status = 'published' then 'The trader explicitly published this source account.' else 'This source account has not been published for Social Trading.' end,
        case when c.status = 'published' then null else 'Publish this account from Social Trading settings.' end,
        (c.status is distinct from 'published')
      from context c where c.id is not null
      union all
      select 2,
        case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'synthetic_preview_disabled' else 'synthetic_policy_passed' end,
        case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'blocked' else 'passed' end,
        case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'warning' else 'success' end,
        case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'This synthetic demo source is restricted to an isolated preview environment.' else 'The source passes the preview-only synthetic participation policy.' end,
        case when (c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled() then 'Use Migration Preview with synthetic participation enabled, or select a genuine connected account.' else null end,
        coalesce((c.is_synthetic or c.is_synthetic_demo) and not public.social_copy_synthetic_participants_enabled(), false)
      from context c where c.id is not null
      union all
      select 3,
        case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then 'source_supported' else 'source_unsupported' end,
        case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then 'passed' else 'blocked' end,
        case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then 'success' else 'error' end,
        case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then 'The source provider and platform are supported.' else 'This broker provider or platform is not supported for verified Social Trading performance.' end,
        case when c.provider in ('fxsocket', 'mtapi') and c.platform in ('MT4', 'MT5') then null else 'Connect a supported FxSocket or MTAPI MT4/MT5 account.' end,
        coalesce(c.provider not in ('fxsocket', 'mtapi') or c.platform not in ('MT4', 'MT5'), true)
      from context c where c.id is not null
      union all
      select 4,
        case when c.account_mode in ('demo', 'live') then 'account_mode_verified' else 'account_mode_unknown' end,
        case when c.account_mode in ('demo', 'live') then 'passed' else 'pending' end,
        case when c.account_mode in ('demo', 'live') then 'success' else 'info' end,
        case when c.account_mode in ('demo', 'live') then 'The broker verified whether this is a demo or live account.' else 'The account demo/live mode has not been verified yet.' end,
        case when c.account_mode in ('demo', 'live') then null else 'Reconnect or synchronize the account so its mode can be verified.' end,
        coalesce(c.account_mode not in ('demo', 'live'), true)
      from context c where c.id is not null
      union all
      select 5,
        case when c.is_active then 'source_active' else 'source_inactive' end,
        case when c.is_active then 'passed' else 'blocked' end,
        case when c.is_active then 'success' else 'error' end,
        case when c.is_active then 'The source account is active.' else 'The source account is inactive.' end,
        case when c.is_active then null else 'Activate the broker connection before using it as a source.' end,
        not coalesce(c.is_active, false)
      from context c where c.id is not null
      union all
      select 6,
        case when c.connection_status = 'error' then 'sync_failed' when c.connection_status not in ('connected', 'healthy') then 'source_disconnected' else 'source_connected' end,
        case when c.connection_status in ('connected', 'healthy') then 'passed' else 'blocked' end,
        case when c.connection_status in ('connected', 'healthy') then 'success' else 'error' end,
        case when c.connection_status = 'error' then 'The latest broker synchronization failed.' when c.connection_status not in ('connected', 'healthy') then 'The source account is disconnected from its broker.' else 'The source broker connection is healthy.' end,
        case when c.connection_status = 'error' then 'Repair or reconnect the broker account, then synchronize it again.' when c.connection_status not in ('connected', 'healthy') then 'Reconnect the source account and confirm that its connection is healthy.' else null end,
        coalesce(c.connection_status not in ('connected', 'healthy'), true)
      from context c where c.id is not null
      union all
      select 7,
        case when c.last_synced_at is null then 'sync_pending' when c.last_synced_at < now() - interval '15 minutes' then 'history_stale' else 'history_fresh' end,
        case when c.last_synced_at is null then 'pending' when c.last_synced_at < now() - interval '15 minutes' then 'blocked' else 'passed' end,
        case when c.last_synced_at is null then 'info' when c.last_synced_at < now() - interval '15 minutes' then 'error' else 'success' end,
        case when c.last_synced_at is null then 'The first successful source synchronization has not completed.' when c.last_synced_at < now() - interval '15 minutes' then 'The source history is older than the 15-minute freshness limit.' else 'The source history is within the 15-minute freshness limit.' end,
        case when c.last_synced_at is null then 'Keep the account connected and wait for synchronization to finish.' when c.last_synced_at < now() - interval '15 minutes' then 'Restore synchronization and wait for a fresh broker snapshot.' else null end,
        (c.last_synced_at is null or c.last_synced_at < now() - interval '15 minutes')
      from context c where c.id is not null
      union all
      select 8,
        'history_complete',
        'passed',
        'success',
        'Known closed-trade results are published as they synchronize.',
        null::text,
        false
      from context c where c.id is not null
      union all
      select 9,
        'minimum_trades_met',
        'passed',
        'success',
        'There is no minimum closed-trade count for copying.',
        null::text,
        false
      from context c where c.id is not null
      union all
      select 10,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'minimum_period_not_met' else 'minimum_period_met' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'pending' else 'passed' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'info' else 'success' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'The verified closed-trade history spans less than 7 days.' else 'The verified closed-trade history spans at least 7 days.' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'Keep the account synchronized until its verified closed-trade history spans at least 7 days.' else null end,
        (c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days')
      from context c where c.id is not null
    ) v
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'order', check_order, 'code', code, 'status', status, 'severity', severity,
    'explanation', explanation, 'next_action', next_action, 'blocking', blocking
  ) order by check_order), '[]'::jsonb)
  from checks;
$$;

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
    case when coalesce(e.closed_count, 0) > 0 then rm.return_percentage end,
    case when coalesce(e.closed_count, 0) > 0 then rm.max_drawdown end,
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

create or replace function public.get_provider_public_performance(p_slug text)
returns table (
  shared boolean,
  currency text,
  last_synced_at timestamptz,
  history_complete boolean,
  open_count bigint,
  closed_count bigint,
  wins bigint,
  win_rate numeric,
  profit_factor numeric,
  realized_profit numeric,
  gross_profit numeric,
  gross_loss numeric,
  best_profit numeric,
  best_at timestamptz,
  worst_profit numeric,
  worst_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  monthly jsonb,
  deposits numeric,
  withdrawals numeric,
  deposit_source text,
  cashflow_synced_at timestamptz,
  max_drawdown numeric,
  return_percentage numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_src record;
  v_facts record;
  v_synced timestamptz;
  v_best record;
  v_worst record;
  v_monthly jsonb;
  v_cash record;
  v_dd numeric;
  v_roi numeric;
begin
  select * into v_src from public.provider_public_shared_source(p_slug);
  if not found then return; end if;

  if not coalesce(v_src.shared, false) or v_src.source_id is null then
    return query select false, v_src.currency, null::timestamptz, null::boolean,
      null::bigint, null::bigint, null::bigint, null::numeric, null::numeric, null::numeric,
      null::numeric, null::numeric, null::numeric, null::timestamptz, null::numeric, null::timestamptz,
      null::timestamptz, null::timestamptz, null::jsonb,
      null::numeric, null::numeric, null::text, null::timestamptz, null::numeric, null::numeric;
    return;
  end if;

  select * into v_facts from public.social_source_trade_facts(v_src.source_id);
  select b.total_deposits, b.total_withdrawals, b.cashflow_synced_at, b.performance_baseline_balance
  into v_cash from public.broker_accounts b where b.id = v_src.broker_account_id;
  select b.last_synced_at into v_synced from public.broker_accounts b where b.id = v_src.broker_account_id;

  select t.realized_profit as profit, t.closed_at as at into v_best
  from public.provider_public_source_trades(v_src.source_id) t
  where t.trade_status = 'closed' and t.realized_profit is not null and t.closed_at is not null
  order by t.realized_profit desc, t.closed_at desc limit 1;

  select t.realized_profit as profit, t.closed_at as at into v_worst
  from public.provider_public_source_trades(v_src.source_id) t
  where t.trade_status = 'closed' and t.realized_profit is not null and t.closed_at is not null
  order by t.realized_profit asc, t.closed_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'profit', m.profit, 'trades', m.trades) order by m.month), '[]'::jsonb)
  into v_monthly
  from (
    select to_char(date_trunc('month', t.closed_at at time zone 'UTC'), 'YYYY-MM') as month,
      round(sum(t.realized_profit), 2) as profit, count(*) as trades
    from public.provider_public_source_trades(v_src.source_id) t
    where t.trade_status = 'closed' and t.realized_profit is not null and t.closed_at is not null
    group by 1
  ) m;

  -- Known closed trades publish ROI / drawdown immediately; incomplete rows no longer block.
  if v_synced is not null and coalesce(v_facts.closed_count, 0) > 0 then
    select rm.return_percentage, rm.max_drawdown into v_roi, v_dd
    from public.social_source_return_metrics(v_src.source_id) rm;
  end if;

  return query select true, v_src.currency, v_synced,
    (coalesce(v_facts.incomplete_count, 0) = 0 and v_synced is not null),
    coalesce(v_facts.open_count, 0), coalesce(v_facts.closed_count, 0), coalesce(v_facts.wins, 0),
    case when coalesce(v_facts.verified_closed_count, 0) > 0
      then round((v_facts.wins::numeric / v_facts.verified_closed_count::numeric) * 100, 2) end,
    case when coalesce(v_facts.gross_loss, 0) > 0 then round(v_facts.gross_profit / v_facts.gross_loss, 2) end,
    v_facts.realized_profit, v_facts.gross_profit, v_facts.gross_loss,
    v_best.profit, v_best.at, v_worst.profit, v_worst.at,
    v_facts.period_start, v_facts.period_end, v_monthly,
    coalesce(v_cash.total_deposits, v_cash.performance_baseline_balance),
    v_cash.total_withdrawals,
    case when v_cash.total_deposits is not null then 'broker_history'
         when v_cash.performance_baseline_balance is not null then 'starting_balance' end,
    v_cash.cashflow_synced_at,
    v_dd,
    v_roi;
end;
$$;

revoke all on function public.get_provider_public_performance(text) from public;
grant execute on function public.get_provider_public_performance(text) to anon, authenticated;
