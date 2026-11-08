-- Keep worker authorization aligned with create_social_copy_subscription:
-- private providers no longer require an accepted follow to stay authorized.

create or replace function public.check_social_copy_subscription_authorization(p_subscription_id uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select case when current_user in ('service_role', 'postgres') then exists (
    select 1
    from public.social_copy_subscriptions s
    join public.social_copy_sources src on src.id = s.source_id
    join public.social_profiles sp on sp.user_id = src.trader_user_id
    left join public.social_profiles subscriber_profile on subscriber_profile.user_id = s.subscriber_user_id
    join public.broker_accounts source_account on source_account.id = src.broker_account_id
    join public.broker_accounts destination_account on destination_account.id = s.destination_broker_account_id
    cross join lateral public.social_source_performance_eligibility(src.id) eligibility
    where s.id = p_subscription_id
      and eligibility.eligible = true
      and src.status = 'published' and sp.is_listed = true
      and source_account.user_id = src.trader_user_id
      and destination_account.user_id = s.subscriber_user_id
      and destination_account.is_active = true
      and lower(coalesce(destination_account.connection_status, '')) in ('connected', 'healthy')
      and lower(coalesce(nullif(destination_account.provider, ''), 'fxsocket')) in ('fxsocket', 'mtapi')
      and upper(coalesce(destination_account.platform, '')) in ('MT4', 'MT5')
      and public.social_broker_account_mode(source_account.id) = s.source_account_mode
      and public.social_broker_account_mode(destination_account.id) = s.destination_account_mode
      and s.requested_account_mode = s.destination_account_mode
      and (
        ((src.is_synthetic = true or sp.is_synthetic_demo = true
          or coalesce(subscriber_profile.is_synthetic_demo, false) = true)
          and public.social_copy_synthetic_participants_enabled()
          and s.execution_path = 'synthetic_simulation')
        or
        ((src.is_synthetic = false and sp.is_synthetic_demo = false
          and coalesce(subscriber_profile.is_synthetic_demo, false) = false)
          and s.execution_path = 'broker')
      )
  ) else false end;
$$;

revoke all on function public.check_social_copy_subscription_authorization(uuid)
  from public, anon, authenticated;
grant execute on function public.check_social_copy_subscription_authorization(uuid) to service_role;
