-- Additive diagnostics and persistent social notifications. Existing eligibility
-- rules remain authoritative; this migration only explains every check.

create or replace function public.social_source_eligibility_diagnostics(p_source_id uuid)
returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
  with source_context as (
    select s.id, s.status, s.broker_account_id, s.is_synthetic, sp.is_synthetic_demo,
      lower(coalesce(nullif(b.provider, ''), 'fxsocket')) as provider,
      upper(coalesce(b.platform, '')) as platform, b.is_active,
      lower(coalesce(b.connection_status, '')) as connection_status,
      coalesce(public.social_broker_account_mode(b.id), 'unknown') as account_mode,
      b.last_synced_at
    from public.social_copy_sources s
    join public.broker_accounts b on b.id = s.broker_account_id and b.user_id = s.trader_user_id
    join public.social_profiles sp on sp.user_id = s.trader_user_id
    where s.id = p_source_id
  ), scoped as (
    select distinct on (t.broker_account_id, coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text))
      t.id, t.broker_account_id, t.metaapi_order_id, t.status, t.opened_at,
      t.closed_at, t.profit, t.created_at
    from public.trades t
    join source_context sc on sc.broker_account_id = t.broker_account_id
    where (lower(t.status) = 'open' or t.closed_at is not null or lower(t.status) = 'closed')
      and not exists (
        select 1 from public.social_copy_subscriptions sub
        join public.social_copy_trade_mappings map on map.subscription_id = sub.id
        where sub.destination_broker_account_id = t.broker_account_id
          and map.destination_ticket is not null and map.destination_ticket = t.metaapi_order_id
      )
    order by t.broker_account_id, coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text), t.created_at desc, t.id desc
  ), facts as (
    select count(*) filter (where lower(status) = 'closed' or closed_at is not null) as closed_count,
      count(*) filter (where (lower(status) = 'closed' or closed_at is not null)
        and (profit is null or metaapi_order_id is null or btrim(metaapi_order_id) = '')) as incomplete_count,
      min(opened_at) filter (where lower(status) = 'closed' or closed_at is not null) as period_start,
      max(closed_at) filter (where lower(status) = 'closed' or closed_at is not null) as period_end
    from scoped
  ), context as (
    select sc.*, coalesce(f.closed_count, 0) as closed_count,
      coalesce(f.incomplete_count, 0) as incomplete_count, f.period_start, f.period_end
    from (select 1) seed left join source_context sc on true cross join facts f
  ), checks as (
    select v.* from context c cross join lateral (values
      (0, case when c.id is null then 'source_missing' else 'source_present' end,
        case when c.id is null then 'blocked' else 'passed' end,
        case when c.id is null then 'error' else 'success' end,
        case when c.id is null then 'The selected source account no longer exists or is not owned by this trader.' else 'The source account exists and is owned by the publishing trader.' end,
        case when c.id is null then 'Choose another owned source account or publish a new one.' else null end,
        c.id is null),
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
        case when c.incomplete_count > 0 then 'One or more closed trades are missing a verified broker ticket or realized result.' else 'All synchronized closed trades have a broker ticket and realized result.' end,
        case when c.incomplete_count > 0 then 'Synchronize the complete closed-trade history before publishing it for copying.' else null end,
        c.incomplete_count > 0),
      (9, case when c.closed_count < 10 then 'minimum_trades_not_met' else 'minimum_trades_met' end,
        case when c.closed_count < 10 then 'pending' else 'passed' end,
        case when c.closed_count < 10 then 'info' else 'success' end,
        case when c.closed_count < 10 then 'Fewer than 10 complete closed trades are available.' else 'At least 10 complete closed trades are available.' end,
        case when c.closed_count < 10 then 'Accumulate at least 10 complete closed trades and synchronize them.' else null end,
        c.closed_count < 10),
      (10, case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'minimum_period_not_met' else 'minimum_period_met' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'pending' else 'passed' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'info' else 'success' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'The verified closed-trade history spans less than 7 days.' else 'The verified closed-trade history spans at least 7 days.' end,
        case when c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days' then 'Keep the account synchronized until its closed-trade history spans at least 7 days.' else null end,
        c.period_start is null or c.period_end is null or c.period_end - c.period_start < interval '7 days')
    ) as v(check_order, code, status, severity, explanation, next_action, blocking)
    where c.id is not null or v.check_order = 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('order', check_order, 'code', code, 'status', status,
    'severity', severity, 'explanation', explanation, 'next_action', next_action, 'blocking', blocking)
    order by check_order), '[]'::jsonb) from checks;
$$;

revoke all on function public.social_source_eligibility_diagnostics(uuid) from public, anon, authenticated;
grant execute on function public.social_source_eligibility_diagnostics(uuid) to service_role;

drop function public.get_social_copy_sources(uuid);
create function public.get_social_copy_sources(p_trader_user_id uuid)
returns table (source_id uuid, label text, provider text, platform text, account_hint text,
  account_mode text, connection_healthy boolean, is_copy_eligible boolean,
  eligibility_reason text, is_synthetic boolean, eligibility_diagnostics jsonb)
language sql stable security definer set search_path = pg_catalog, public as $$
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
    and (sp.access_mode = 'open' or s.trader_user_id = auth.uid() or exists (
      select 1 from public.social_follow_relationships r where r.follower_user_id = auth.uid()
        and r.followed_user_id = s.trader_user_id and r.status = 'accepted'))
  order by s.created_at, s.id;
$$;
revoke all on function public.get_social_copy_sources(uuid) from public, anon;
grant execute on function public.get_social_copy_sources(uuid) to authenticated;

create table public.in_app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'social_follow_accepted', 'social_copy_activated', 'social_copy_stopped', 'social_copy_suspended'
  )),
  event_key text not null,
  title text not null,
  body text not null,
  action_url text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, event_key)
);
create index in_app_notifications_user_created_idx on public.in_app_notifications (user_id, created_at desc);
alter table public.in_app_notifications enable row level security;
revoke all on table public.in_app_notifications from public, anon, authenticated;
grant select on table public.in_app_notifications to authenticated;
grant update (read_at) on table public.in_app_notifications to authenticated;
grant all on table public.in_app_notifications to service_role;
create policy users_read_own_in_app_notifications on public.in_app_notifications
  for select to authenticated using (user_id = auth.uid());
create policy users_mark_own_in_app_notifications_read on public.in_app_notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.create_social_event_notification()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_error_code text; v_transition boolean;
begin
  if tg_table_name = 'social_follow_relationships' then
    if tg_op = 'INSERT' then v_transition := true;
    else v_transition := old.status is distinct from 'accepted';
    end if;
    if new.status = 'accepted' and v_transition then
      insert into public.in_app_notifications
        (user_id, actor_user_id, event_type, event_key, title, body, action_url, metadata)
      values (new.followed_user_id, new.follower_user_id, 'social_follow_accepted',
        'social-follow-accepted:' || new.id, 'New social follower',
        'A trader is now following your Social Trading profile.',
        '/social-trading/' || new.follower_user_id::text,
        jsonb_build_object('relationship_id', new.id))
      on conflict (user_id, event_key) do nothing;
    end if;
    return new;
  end if;

  if new.status = 'active' and old.status is distinct from 'active' then
    insert into public.in_app_notifications
      (user_id, actor_user_id, event_type, event_key, title, body, action_url, metadata)
    values (new.source_trader_user_id, new.subscriber_user_id, 'social_copy_activated',
      'social-copy-activated:' || new.id, 'New copier activated',
      'A copy subscription to your published source is now active.',
      '/social-trading/' || new.subscriber_user_id::text,
      jsonb_build_object('subscription_id', new.id, 'source_id', new.source_id))
    on conflict (user_id, event_key) do nothing;
  elsif new.status in ('stopped', 'emergency_stopped') and old.status is distinct from new.status then
    insert into public.in_app_notifications
      (user_id, actor_user_id, event_type, event_key, title, body, action_url, metadata)
    values (new.source_trader_user_id, new.subscriber_user_id, 'social_copy_stopped',
      'social-copy-stopped:' || new.id, 'Copy subscription stopped',
      'A copier has stopped copying your published source.',
      '/social-trading/' || new.subscriber_user_id::text,
      jsonb_build_object('subscription_id', new.id, 'source_id', new.source_id))
    on conflict (user_id, event_key) do nothing;
  elsif new.status = 'error' and old.status is distinct from 'error' then
    v_error_code := coalesce(nullif(new.error_code, ''), 'unknown');
    insert into public.in_app_notifications
      (user_id, event_type, event_key, title, body, action_url, metadata)
    values (new.subscriber_user_id, 'social_copy_suspended',
      'social-copy-suspended:' || new.id || ':' || v_error_code,
      'Copy subscription needs attention',
      'Your copy subscription was suspended after reconciliation failed. Review its status before resuming.',
      '/social-trading/' || new.source_trader_user_id::text,
      jsonb_build_object('subscription_id', new.id, 'source_id', new.source_id, 'error_code', v_error_code))
    on conflict (user_id, event_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists social_follow_accepted_notification on public.social_follow_relationships;
create trigger social_follow_accepted_notification
after insert or update of status on public.social_follow_relationships
for each row execute function public.create_social_event_notification();

drop trigger if exists social_copy_status_notification on public.social_copy_subscriptions;
create trigger social_copy_status_notification
after update of status on public.social_copy_subscriptions
for each row execute function public.create_social_event_notification();

revoke all on function public.create_social_event_notification() from public, anon, authenticated;

-- The bell waits for realtime readiness; publication enables delivery where
-- Realtime is available, while refresh remains the fallback.
alter publication supabase_realtime add table public.in_app_notifications;
