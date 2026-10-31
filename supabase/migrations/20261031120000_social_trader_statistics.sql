-- Authoritative, privacy-preserving live copier statistic.
--
-- "Live" means the worker has acknowledged a subscription that both the
-- subscriber and runtime still consider active. The RPC returns only a count
-- and applies the same profile visibility rule as other social read RPCs.

create or replace function public.get_social_trader_live_copier_count(
  p_trader_user_id uuid
)
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_access_mode text;
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select sp.access_mode
  into v_access_mode
  from public.social_profiles sp
  where sp.user_id = p_trader_user_id
    and sp.is_listed = true;

  if not found then
    raise exception 'Social profile is not available' using errcode = 'P0002';
  end if;

  if v_actor <> p_trader_user_id
     and v_access_mode <> 'open'
     and not exists (
       select 1
       from public.social_follow_relationships relationship
       where relationship.follower_user_id = v_actor
         and relationship.followed_user_id = p_trader_user_id
         and relationship.status = 'accepted'
     )
  then
    raise exception 'Social profile is not available to this viewer' using errcode = '42501';
  end if;

  return (
    select count(*)
    from public.social_copy_subscriptions subscription
    join public.social_copy_sources source
      on source.id = subscription.source_id
     and source.trader_user_id = subscription.source_trader_user_id
    where subscription.source_trader_user_id = p_trader_user_id
      and source.trader_user_id = p_trader_user_id
      and subscription.status = 'active'
      and subscription.desired_status = 'active'
      and subscription.worker_acknowledged_at is not null
  );
end;
$$;

comment on function public.get_social_trader_live_copier_count(uuid) is
  'Counts only worker-acknowledged active copy subscriptions whose desired lifecycle remains active; exposes no subscriber identity.';

revoke all on function public.get_social_trader_live_copier_count(uuid) from public, anon;
grant execute on function public.get_social_trader_live_copier_count(uuid) to authenticated;