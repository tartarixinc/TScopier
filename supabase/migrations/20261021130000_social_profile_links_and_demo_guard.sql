-- Persist public social profile links and make synthetic demo providers
-- impossible to copy at the database boundary.

create or replace function public.social_profile_links_are_valid(p_links jsonb)
returns boolean
language sql immutable set search_path = pg_catalog as $$
  select jsonb_typeof(coalesce(p_links, '{}'::jsonb)) = 'object'
    and not exists (
      select 1 from jsonb_each(coalesce(p_links, '{}'::jsonb)) entry
      where entry.key not in ('x', 'instagram', 'linkedin', 'youtube', 'tiktok', 'facebook')
        or jsonb_typeof(entry.value) <> 'string'
        or length(entry.value #>> '{}') > 500
        or not (
          (entry.key = 'x' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*(x\.com|twitter\.com)/[^[:space:]]+$')
          or (entry.key = 'instagram' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*instagram\.com/[^[:space:]]+$')
          or (entry.key = 'linkedin' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*linkedin\.com/[^[:space:]]+$')
          or (entry.key = 'youtube' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*(youtube\.com|youtu\.be)/[^[:space:]]+$')
          or (entry.key = 'tiktok' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*tiktok\.com/[^[:space:]]+$')
          or (entry.key = 'facebook' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*facebook\.com/[^[:space:]]+$')
        )
    );
$$;

alter table public.user_profiles
  add column if not exists social_links jsonb not null default '{}'::jsonb;

alter table public.user_profiles
  drop constraint if exists user_profiles_social_links_valid;
alter table public.user_profiles
  add constraint user_profiles_social_links_valid
  check (public.social_profile_links_are_valid(social_links));

alter table public.social_profiles
  add column if not exists monthly_copy_price_cents integer,
  add column if not exists is_synthetic_demo boolean not null default false;

alter table public.social_profiles
  drop constraint if exists social_profiles_monthly_copy_price_valid;
alter table public.social_profiles
  add constraint social_profiles_monthly_copy_price_valid
  check (monthly_copy_price_cents is null or monthly_copy_price_cents between 0 and 10000000);

create or replace function public.set_social_profile_links(p_links jsonb)
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_profile_links_are_valid(coalesce(p_links, '{}'::jsonb)) then
    raise exception 'Invalid social profile links' using errcode = '22023';
  end if;
  update public.user_profiles
  set social_links = coalesce(p_links, '{}'::jsonb), updated_at = now()
  where user_id = v_actor;
  if not found then raise exception 'User profile is unavailable' using errcode = 'P0002'; end if;
end;
$$;

drop function public.get_social_directory();
create function public.get_social_directory()
returns table (
  profile_user_id uuid, display_name text, username text, country text,
  access_mode text, is_self boolean, follower_count bigint, following_count bigint,
  viewer_relationship_status text, follows_viewer_status text, average_rating numeric,
  review_count bigint, viewer_rating smallint, shares_trade_history boolean,
  created_at timestamptz, monthly_copy_price_cents integer,
  is_synthetic_demo boolean, social_links jsonb
)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
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
    sp.is_synthetic_demo, coalesce(up.social_links, '{}'::jsonb)
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  left join public.social_follow_relationships outgoing
    on outgoing.follower_user_id = v_actor and outgoing.followed_user_id = sp.user_id
  left join public.social_follow_relationships incoming_viewer
    on incoming_viewer.follower_user_id = sp.user_id and incoming_viewer.followed_user_id = v_actor
  where sp.is_listed = true
    and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
  order by 7 desc, 2 asc, 1 asc;
end;
$$;

create or replace function public.get_social_copy_sources(p_trader_user_id uuid)
returns table (
  source_id uuid, trader_user_id uuid, label text, provider text, platform text,
  account_mode text, connection_healthy boolean, is_copy_eligible boolean,
  eligibility_reason text
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select s.id, s.trader_user_id, coalesce(s.label, 'Copy source'),
    coalesce(b.provider, 'fxsocket'), b.platform,
    case when lower(coalesce(b.linked_account_type, '')) in ('demo', 'practice') then 'demo'
         when coalesce(b.linked_account_type, '') = '' then 'unknown' else 'live' end,
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
        where r.follower_user_id = auth.uid() and r.followed_user_id = s.trader_user_id and r.status = 'accepted'));
$$;

create or replace function public.reject_synthetic_social_copy_subscription()
returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if exists (
    select 1 from public.social_copy_sources source
    join public.social_profiles profile on profile.user_id = source.trader_user_id
    where source.id = new.source_id and profile.is_synthetic_demo = true
  ) then
    raise exception 'Synthetic demo traders cannot be copied' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists reject_synthetic_social_copy_subscription on public.social_copy_subscriptions;
create trigger reject_synthetic_social_copy_subscription
before insert or update of source_id on public.social_copy_subscriptions
for each row execute function public.reject_synthetic_social_copy_subscription();

revoke all on function public.social_profile_links_are_valid(jsonb) from public, anon, authenticated;
revoke all on function public.set_social_profile_links(jsonb) from public, anon;
revoke all on function public.reject_synthetic_social_copy_subscription() from public, anon, authenticated;
revoke all on function public.get_social_directory() from public, anon;
revoke all on function public.get_social_copy_sources(uuid) from public, anon;
grant execute on function public.set_social_profile_links(jsonb) to authenticated;
grant execute on function public.get_social_directory() to authenticated;
grant execute on function public.get_social_copy_sources(uuid) to authenticated;

comment on column public.user_profiles.social_links is 'Validated public profile URLs only; never OAuth tokens or external account permissions.';
comment on column public.social_profiles.is_synthetic_demo is 'Authoritative server-side block for copy subscriptions targeting seeded demo providers.';
