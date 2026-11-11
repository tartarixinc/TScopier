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
