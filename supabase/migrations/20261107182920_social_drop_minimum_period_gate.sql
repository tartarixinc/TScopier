-- Temporarily drop the 7-day verified-history copy gate so newly published
-- sources can be copied before a full week of closed trades is available.

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
    select sc.*
    from (select 1) seed
    left join source_context sc on true
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
      else 'eligible'
    end
  from evaluated;
$$;

comment on function public.social_source_performance_eligibility(uuid) is
  'Requires a published, supported, fresh source. Incomplete rows, trade-count, and 7-day period minimums are not blockers.';

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
        'minimum_period_met',
        'passed',
        'success',
        'The 7-day history minimum is temporarily not required for copying.',
        null::text,
        false
      from context c where c.id is not null
    ) v
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'order', check_order, 'code', code, 'status', status, 'severity', severity,
    'explanation', explanation, 'next_action', next_action, 'blocking', blocking
  ) order by check_order), '[]'::jsonb)
  from checks;
$$;
