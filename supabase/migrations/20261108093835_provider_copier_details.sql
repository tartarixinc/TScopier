-- Provider copier details: balance/equity/risk for a subscription the caller owns as provider.
-- Also point activation/stop notifications at the copier details route instead of the subscriber profile.

create or replace function public.get_provider_copier_details(p_subscription_id uuid)
returns table (
  subscription_id uuid,
  subscriber_user_id uuid,
  display_name text,
  username text,
  status text,
  desired_status text,
  sizing_mode text,
  fixed_lot numeric,
  lot_multiplier numeric,
  max_lot numeric,
  manual_settings jsonb,
  destination_broker_account_id uuid,
  destination_platform text,
  destination_broker_name text,
  destination_label text,
  destination_balance numeric,
  destination_equity numeric,
  destination_currency text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.social_profiles sp
    where sp.user_id = v_actor and sp.provider_status = 'approved'
  ) then
    raise exception 'Only approved providers can view copier details' using errcode = '42501';
  end if;

  return query
  select
    s.id,
    s.subscriber_user_id,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), ''), 'Trader')::text,
    coalesce(nullif(btrim(up.username), ''), '')::text,
    s.status::text,
    s.desired_status::text,
    s.sizing_mode::text,
    s.fixed_lot,
    s.lot_multiplier,
    s.max_lot,
    coalesce(s.manual_settings, '{}'::jsonb),
    s.destination_broker_account_id,
    ba.platform::text,
    nullif(btrim(ba.broker_name), '')::text,
    nullif(btrim(ba.label), '')::text,
    ba.last_balance,
    ba.last_equity,
    nullif(btrim(ba.last_currency), '')::text,
    s.created_at,
    s.updated_at
  from public.social_copy_subscriptions s
  left join public.user_profiles up on up.user_id = s.subscriber_user_id
  left join public.broker_accounts ba on ba.id = s.destination_broker_account_id
  where s.id = p_subscription_id
    and s.source_trader_user_id = v_actor;
end;
$$;

revoke all on function public.get_provider_copier_details(uuid) from public, anon;
grant execute on function public.get_provider_copier_details(uuid) to authenticated;

comment on function public.get_provider_copier_details(uuid) is
  'Returns one copier subscription (balance, equity, sizing/risk) for the approved provider who owns the source.';

create or replace function public.create_social_event_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_error_code text;
  v_transition boolean;
begin
  if tg_table_name = 'social_follow_relationships' then
    if tg_op = 'INSERT' then
      v_transition := true;
    else
      v_transition := old.status is distinct from 'accepted';
    end if;
    if new.status = 'accepted' and v_transition then
      insert into public.in_app_notifications
        (user_id, actor_user_id, event_type, event_key, title, body, action_url, metadata)
      values (
        new.followed_user_id,
        new.follower_user_id,
        'social_follow_accepted',
        'social-follow-accepted:' || new.id,
        'New social follower',
        'A trader is now following your Social Trading profile.',
        '/social-trading/' || new.follower_user_id::text,
        jsonb_build_object('relationship_id', new.id)
      )
      on conflict (user_id, event_key) do nothing;
    end if;
    return new;
  end if;

  if new.status = 'active' and old.status is distinct from 'active' then
    insert into public.in_app_notifications
      (user_id, actor_user_id, event_type, event_key, title, body, action_url, metadata)
    values (
      new.source_trader_user_id,
      new.subscriber_user_id,
      'social_copy_activated',
      'social-copy-activated:' || new.id,
      'New copier activated',
      'A copy subscription to your published source is now active.',
      '/social-trading/provider/copiers/' || new.id::text,
      jsonb_build_object('subscription_id', new.id, 'source_id', new.source_id)
    )
    on conflict (user_id, event_key) do nothing;
  elsif new.status in ('stopped', 'emergency_stopped') and old.status is distinct from new.status then
    insert into public.in_app_notifications
      (user_id, actor_user_id, event_type, event_key, title, body, action_url, metadata)
    values (
      new.source_trader_user_id,
      new.subscriber_user_id,
      'social_copy_stopped',
      'social-copy-stopped:' || new.id,
      'Copy subscription stopped',
      'A copier has stopped copying your published source.',
      '/social-trading/provider/copiers/' || new.id::text,
      jsonb_build_object('subscription_id', new.id, 'source_id', new.source_id)
    )
    on conflict (user_id, event_key) do nothing;
  elsif new.status = 'error' and old.status is distinct from 'error' then
    v_error_code := coalesce(nullif(new.error_code, ''), 'unknown');
    insert into public.in_app_notifications
      (user_id, event_type, event_key, title, body, action_url, metadata)
    values (
      new.subscriber_user_id,
      'social_copy_suspended',
      'social-copy-suspended:' || new.id || ':' || v_error_code,
      'Copy subscription needs attention',
      'Your copy subscription was suspended after reconciliation failed. Review its status before resuming.',
      '/social-trading/' || new.source_trader_user_id::text,
      jsonb_build_object('subscription_id', new.id, 'source_id', new.source_id, 'error_code', v_error_code)
    )
    on conflict (user_id, event_key) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.create_social_event_notification() from public, anon, authenticated;
grant execute on function public.create_social_event_notification() to service_role;

-- Rewrite existing provider-facing copy notifications that linked to subscriber profiles.
update public.in_app_notifications n
set action_url = '/social-trading/provider/copiers/' || (n.metadata->>'subscription_id')
where n.event_type in ('social_copy_activated', 'social_copy_stopped')
  and n.metadata ? 'subscription_id'
  and coalesce(n.action_url, '') like '/social-trading/%'
  and coalesce(n.action_url, '') not like '/social-trading/provider/%';
