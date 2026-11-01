-- Public provider profile: expose the profile photo.
-- Only URLs that point at our own public profile-photos bucket are returned, so a
-- user-supplied external URL can never be rendered (or tracked) on a public page.

drop function if exists public.get_provider_public_profile(text);

create or replace function public.get_provider_public_profile(p_slug text)
returns table (
  profile_user_id uuid, slug text, display_name text, username text, country text, bio text,
  access_mode text, follower_count bigint, average_rating numeric, review_count bigint,
  monthly_copy_price_cents integer, social_links jsonb,
  account_kind text, platform text, balance numeric, equity numeric, currency text,
  snapshot_at timestamptz, joined_at timestamptz, avatar_url text
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select sp.user_id, sp.slug,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')),
    coalesce(nullif(btrim(up.username), ''), ''), coalesce(nullif(btrim(up.country), ''), ''),
    sp.bio, sp.access_mode,
    (select count(*) from public.social_follow_relationships f
      where f.followed_user_id = sp.user_id and f.status = 'accepted'),
    (select round(avg(r.rating)::numeric, 2) from public.social_trader_reviews r where r.trader_user_id = sp.user_id),
    (select count(*) from public.social_trader_reviews r where r.trader_user_id = sp.user_id),
    sp.monthly_copy_price_cents, coalesce(up.social_links, '{}'::jsonb),
    src.account_kind, src.platform, src.snapshot_balance, src.snapshot_equity,
    src.snapshot_currency, src.snapshot_at, sp.created_at,
    case when up.avatar_url like 'https://%/storage/v1/object/public/profile-photos/%'
      then up.avatar_url end
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  left join lateral (
    select s.account_kind, s.platform, s.snapshot_balance, s.snapshot_equity, s.snapshot_currency, s.snapshot_at
    from public.social_copy_sources s
    where s.trader_user_id = sp.user_id and s.status = 'published'
    order by s.created_at asc
    limit 1
  ) src on true
  where sp.slug = lower(btrim(p_slug))
    and sp.is_listed = true
    and sp.provider_status = 'approved'
    and sp.is_synthetic_demo = false
    and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
$$;

revoke all on function public.get_provider_public_profile(text) from public;
grant execute on function public.get_provider_public_profile(text) to anon, authenticated;
