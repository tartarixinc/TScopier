-- Expose the provider's profile timezone on the social directory so overview
-- can show it (was always an em dash because the RPC never returned it).

drop function if exists public.get_social_directory();

create function public.get_social_directory()
returns table (
  profile_user_id uuid,
  display_name text,
  username text,
  country text,
  access_mode text,
  is_self boolean,
  follower_count bigint,
  following_count bigint,
  viewer_relationship_status text,
  follows_viewer_status text,
  average_rating numeric,
  review_count bigint,
  viewer_rating smallint,
  shares_trade_history boolean,
  created_at timestamptz,
  monthly_copy_price_cents integer,
  is_synthetic_demo boolean,
  social_links jsonb,
  slug text,
  provider_status text,
  bio text,
  account_kind text,
  platform text,
  balance numeric,
  equity numeric,
  currency text,
  snapshot_at timestamptz,
  timezone text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  return query
  select sp.user_id,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')),
    coalesce(nullif(btrim(up.username), ''), ''), coalesce(nullif(btrim(up.country), ''), ''),
    sp.access_mode, sp.user_id = v_actor,
    (select count(*) from public.social_follow_relationships incoming
      join public.social_profiles ip on ip.user_id = incoming.follower_user_id
      join public.user_profiles ii on ii.user_id = incoming.follower_user_id
      where incoming.followed_user_id = sp.user_id and incoming.status = 'accepted'
        and ip.is_listed = true
        and coalesce(nullif(btrim(ii.display_name), ''), nullif(btrim(ii.username), '')) is not null),
    (select count(*) from public.social_follow_relationships outgoing_count
      join public.social_profiles fp on fp.user_id = outgoing_count.followed_user_id
      join public.user_profiles fi on fi.user_id = outgoing_count.followed_user_id
      where outgoing_count.follower_user_id = sp.user_id and outgoing_count.status = 'accepted'
        and fp.is_listed = true
        and coalesce(nullif(btrim(fi.display_name), ''), nullif(btrim(fi.username), '')) is not null),
    outgoing.status, incoming_viewer.status,
    (select round(avg(r.rating)::numeric, 2) from public.social_trader_reviews r where r.trader_user_id = sp.user_id),
    (select count(*) from public.social_trader_reviews r where r.trader_user_id = sp.user_id),
    (select r.rating from public.social_trader_reviews r where r.trader_user_id = sp.user_id and r.reviewer_user_id = v_actor),
    sp.share_trade_history, sp.created_at, sp.monthly_copy_price_cents,
    sp.is_synthetic_demo, coalesce(up.social_links, '{}'::jsonb),
    sp.slug, sp.provider_status, sp.bio,
    src.account_kind, src.platform, src.snapshot_balance, src.snapshot_equity,
    src.snapshot_currency, src.snapshot_at,
    nullif(btrim(up.timezone), '')
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  left join public.social_follow_relationships outgoing
    on outgoing.follower_user_id = v_actor and outgoing.followed_user_id = sp.user_id
  left join public.social_follow_relationships incoming_viewer
    on incoming_viewer.follower_user_id = sp.user_id and incoming_viewer.followed_user_id = v_actor
  left join lateral (
    select s.account_kind, s.platform, s.snapshot_balance, s.snapshot_equity, s.snapshot_currency, s.snapshot_at
    from public.social_copy_sources s
    where s.trader_user_id = sp.user_id and s.status = 'published'
    order by s.created_at asc
    limit 1
  ) src on true
  where sp.is_listed = true
    and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
  order by 7 desc, 2 asc, 1 asc;
end;
$$;

revoke all on function public.get_social_directory() from public, anon;
grant execute on function public.get_social_directory() to authenticated;
