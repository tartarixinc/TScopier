-- ROI and max drawdown, computed server-side from the realized-balance curve (same method as the account analytics).

-- Realized-balance return metrics for a published source: ROI (% of the performance baseline balance)
-- and max drawdown (%, worst peak-to-trough decline of the realized-balance curve). Deposits and
-- withdrawals are excluded. Internal helper for the security-definer performance RPCs.
create or replace function public.social_source_return_metrics(p_source_id uuid)
returns table (return_percentage numeric, max_drawdown numeric)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with ctx as (
    select b.performance_baseline_balance as baseline
    from public.social_copy_sources s
    join public.broker_accounts b on b.id = s.broker_account_id and b.user_id = s.trader_user_id
    where s.id = p_source_id
  ), closed as (
    select t.trade_id, t.closed_at, t.realized_profit
    from public.provider_public_source_trades(p_source_id) t
    where t.trade_status = 'closed' and t.realized_profit is not null and t.closed_at is not null
  ), running as (
    select c.trade_id, c.closed_at, c.realized_profit, ctx.baseline,
      ctx.baseline + sum(c.realized_profit) over (order by c.closed_at, c.trade_id) as bal
    from closed c cross join ctx
  ), peaks as (
    select r.*, greatest(r.baseline, max(r.bal) over (order by r.closed_at, r.trade_id rows between unbounded preceding and current row)) as peak
    from running r
  )
  select
    case when min(baseline) > 0 and count(*) > 0 then round(sum(realized_profit) / min(baseline) * 100, 2) end,
    case when min(baseline) > 0 and count(*) > 0
      then round(coalesce(max(case when peak > 0 then (peak - bal) / peak * 100 else 0 end), 0), 2) end
  from peaks;
$$;

revoke all on function public.social_source_return_metrics(uuid) from public, anon, authenticated;

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

revoke all on function public.get_social_provider_performance(uuid)
  from public, anon;
grant execute on function public.get_social_provider_performance(uuid)
  to authenticated;

drop function if exists public.get_provider_public_performance(text);
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

  -- ROI and max drawdown from the realized-balance curve; only for a complete, synced history.
  if coalesce(v_facts.incomplete_count, 0) = 0 and v_synced is not null then
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
