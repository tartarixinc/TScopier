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

