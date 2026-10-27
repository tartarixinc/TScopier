-- Allow providers to share broker accounts independently. Subscriptions remain
-- source-account-specific and revocation requests a worker-acknowledged pause.

drop index if exists public.social_copy_sources_one_published_per_trader_idx;

create or replace function public.publish_social_copy_source(
  p_broker_account_id uuid,
  p_label text default null
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_id uuid;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Social copy source publishing requires a verified account' using errcode = '42501';
  end if;
  if not public.social_follow_profile_is_eligible(v_actor) then
    raise exception 'Join the social directory before publishing a copy source' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.broker_accounts b
    where b.id = p_broker_account_id and b.user_id = v_actor
  ) then
    raise exception 'Broker account is not owned by the current user' using errcode = '42501';
  end if;

  insert into public.social_copy_sources (trader_user_id, broker_account_id, status, label)
  values (v_actor, p_broker_account_id, 'published', nullif(btrim(p_label), ''))
  on conflict (broker_account_id) do update set
    status = 'published', label = excluded.label, updated_at = now()
  where public.social_copy_sources.trader_user_id = v_actor
  returning id into v_id;
  if v_id is null then raise exception 'Copy source belongs to another trader' using errcode = '42501'; end if;
  return v_id;
end;
$$;

create or replace function public.set_social_copy_source_status(p_source_id uuid, p_status text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if p_status not in ('published', 'paused', 'retired') then
    raise exception 'Invalid copy source status' using errcode = '22023';
  end if;

  update public.social_copy_sources
  set status = p_status, updated_at = now()
  where id = p_source_id and trader_user_id = v_actor;
  if not found then raise exception 'Copy source was not found' using errcode = 'P0002'; end if;

  if p_status <> 'published' then
    update public.social_copy_subscriptions
    set desired_status = 'paused', updated_at = now()
    where source_id = p_source_id
      and status not in ('stopped', 'emergency_stopped')
      and desired_status <> 'stopped';
  end if;
end;
$$;

drop function public.get_social_copy_sources(uuid);
create function public.get_social_copy_sources(p_trader_user_id uuid)
returns table (
  source_id uuid,
  trader_user_id uuid,
  label text,
  provider text,
  platform text,
  account_hint text,
  account_mode text,
  connection_healthy boolean,
  is_copy_eligible boolean,
  eligibility_reason text
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select s.id, s.trader_user_id, coalesce(s.label, 'Copy source'),
    coalesce(b.provider, 'fxsocket'), b.platform,
    case
      when nullif(btrim(b.account_login), '') is null then 'Identifier unavailable'
      else repeat(chr(8226), 4) || right(btrim(b.account_login), 4)
    end,
    case when lower(coalesce(b.linked_account_type, '')) in ('demo', 'practice') then 'demo'
         when lower(coalesce(b.linked_account_type, '')) = 'live' then 'live'
         when lower(coalesce(b.ctrader_environment, b.binance_environment, b.bybit_environment, b.tradelocker_environment, '')) = 'demo' then 'demo'
         when lower(coalesce(b.ctrader_environment, b.binance_environment, b.bybit_environment, b.tradelocker_environment, '')) = 'live' then 'live'
         else 'unknown' end,
    (b.is_active = true and b.connection_status in ('connected', 'healthy')),
    (eligibility.eligible and not sp.is_synthetic_demo),
    case when sp.is_synthetic_demo then 'synthetic_demo' else eligibility.reason end
  from public.social_copy_sources s
  join public.broker_accounts b on b.id = s.broker_account_id and b.user_id = s.trader_user_id
  join public.social_profiles sp on sp.user_id = s.trader_user_id and sp.is_listed = true
  cross join lateral public.social_source_performance_eligibility(s.id) eligibility
  where s.trader_user_id = p_trader_user_id and s.status = 'published'
    and (sp.access_mode = 'open' or s.trader_user_id = auth.uid()
      or exists (select 1 from public.social_follow_relationships r
        where r.follower_user_id = auth.uid() and r.followed_user_id = s.trader_user_id and r.status = 'accepted'))
  order by s.created_at, s.id;
$$;

revoke all on function public.publish_social_copy_source(uuid, text) from public, anon;
revoke all on function public.set_social_copy_source_status(uuid, text) from public, anon;
revoke all on function public.get_social_copy_sources(uuid) from public, anon;
grant execute on function public.publish_social_copy_source(uuid, text) to authenticated;
grant execute on function public.set_social_copy_source_status(uuid, text) to authenticated;
grant execute on function public.get_social_copy_sources(uuid) to authenticated;

comment on function public.publish_social_copy_source(uuid, text) is
  'Explicitly shares one owned broker account without changing any other account sharing preference.';
comment on function public.set_social_copy_source_status(uuid, text) is
  'Changes one owned source. Revocation requests pauses for current subscriptions; it does not silently delete them.';
