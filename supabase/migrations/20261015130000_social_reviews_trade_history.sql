-- Persisted trader reviews and an explicitly consented, narrow view of genuine
-- TScopier-recorded trade history. Broker credentials and account identifiers
-- are never returned by these functions.

alter table public.social_profiles
  add column if not exists share_trade_history boolean not null default false;

create table public.social_trader_reviews (
  id uuid primary key default gen_random_uuid(),
  reviewer_user_id uuid not null references auth.users(id) on delete cascade,
  trader_user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  review_text text not null check (
    char_length(btrim(review_text)) between 1 and 2000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_trader_reviews_not_self check (reviewer_user_id <> trader_user_id),
  constraint social_trader_reviews_pair_unique unique (reviewer_user_id, trader_user_id)
);

create index social_trader_reviews_trader_idx
  on public.social_trader_reviews (trader_user_id, updated_at desc);

create trigger social_trader_reviews_updated_at
  before update on public.social_trader_reviews
  for each row execute function public.set_social_updated_at();

alter table public.social_trader_reviews enable row level security;

revoke all on table public.social_trader_reviews from anon, authenticated;
grant insert, update, delete on table public.social_trader_reviews to authenticated;
grant all on table public.social_trader_reviews to service_role;

create policy "Review authors can insert their own review"
  on public.social_trader_reviews for insert to authenticated
  with check (
    reviewer_user_id = auth.uid()
    and trader_user_id <> auth.uid()
    and exists (
      select 1 from public.social_profiles sp
      where sp.user_id = trader_user_id and sp.is_listed = true
    )
  );

create policy "Review authors can update their own review"
  on public.social_trader_reviews for update to authenticated
  using (reviewer_user_id = auth.uid())
  with check (
    reviewer_user_id = auth.uid() and trader_user_id <> auth.uid()
    and exists (select 1 from public.social_profiles sp
      where sp.user_id = trader_user_id and sp.is_listed = true)
  );


create policy "Review authors can delete their own review"
  on public.social_trader_reviews for delete to authenticated
  using (reviewer_user_id = auth.uid());

create or replace function public.upsert_social_trader_review(
  p_trader_user_id uuid,
  p_rating integer,
  p_review_text text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_id uuid; v_text text := btrim(coalesce(p_review_text, ''));
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if p_trader_user_id is null then raise exception 'Trader user id is required' using errcode = '22004'; end if;
  if p_trader_user_id = v_actor then raise exception 'Users cannot review themselves' using errcode = '23514'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5' using errcode = '22023';
  end if;
  if char_length(v_text) < 1 or char_length(v_text) > 2000 then
    raise exception 'Review text must contain between 1 and 2000 characters' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.social_profiles sp
    where sp.user_id = p_trader_user_id and sp.is_listed = true
  ) then raise exception 'Social profile is not available' using errcode = 'P0002'; end if;

  insert into public.social_trader_reviews (reviewer_user_id, trader_user_id, rating, review_text)
  values (v_actor, p_trader_user_id, p_rating, v_text)
  on conflict (reviewer_user_id, trader_user_id) do update
    set rating = excluded.rating, review_text = excluded.review_text
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.delete_social_trader_review(p_trader_user_id uuid)
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  delete from public.social_trader_reviews
  where reviewer_user_id = v_actor and trader_user_id = p_trader_user_id;
  if not found then raise exception 'Review was not found' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.get_social_trader_reviews(p_trader_user_id uuid)
returns table (
  review_id uuid,
  rating smallint,
  review_text text,
  reviewer_display_name text,
  reviewer_username text,
  is_own boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.social_profiles sp
    where sp.user_id = p_trader_user_id and sp.is_listed = true
  ) then raise exception 'Social profile is not available' using errcode = 'P0002'; end if;

  return query
  select r.id, r.rating, r.review_text,
    case when reviewer_social.is_listed = true
      then coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), ''))
      else null end,
    case when reviewer_social.is_listed = true then nullif(btrim(up.username), '') else null end,
    r.reviewer_user_id = v_actor,
    r.created_at, r.updated_at
  from public.social_trader_reviews r
  left join public.social_profiles reviewer_social on reviewer_social.user_id = r.reviewer_user_id
  left join public.user_profiles up on up.user_id = r.reviewer_user_id
  where r.trader_user_id = p_trader_user_id
  order by (r.reviewer_user_id = v_actor) desc, r.updated_at desc, r.id;
end;
$$;

-- Extend the existing safe directory RPC with persisted review aggregates.
drop function public.get_social_directory();
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
  shares_trade_history boolean
)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  return query
  select sp.user_id,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')),
    coalesce(nullif(btrim(up.username), ''), ''),
    coalesce(nullif(btrim(up.country), ''), ''),
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
    sp.share_trade_history
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

create or replace function public.set_social_trade_history_sharing(p_enabled boolean)
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  update public.social_profiles set share_trade_history = coalesce(p_enabled, false)
  where user_id = v_actor and is_listed = true;
  if not found then raise exception 'Social profile is not registered' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.get_social_trade_history_access(p_trader_user_id uuid)
returns table (sharing_enabled boolean, can_view boolean)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_profile public.social_profiles%rowtype;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_profile from public.social_profiles
  where user_id = p_trader_user_id and is_listed = true;
  if not found then raise exception 'Social profile is not available' using errcode = 'P0002'; end if;
  return query select v_profile.share_trade_history,
    (v_actor = p_trader_user_id or (
      v_profile.share_trade_history and (
        v_profile.access_mode = 'open' or exists (
          select 1 from public.social_follow_relationships r
          where r.follower_user_id = v_actor and r.followed_user_id = p_trader_user_id and r.status = 'accepted'
        )
      )
    ));
end;
$$;

create or replace function public.get_social_trade_history(p_trader_user_id uuid, p_limit integer default 100)
returns table (
  trade_id uuid,
  symbol text,
  direction text,
  trade_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  realized_profit numeric
)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor uuid := auth.uid(); v_allowed boolean;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select a.can_view into v_allowed from public.get_social_trade_history_access(p_trader_user_id) a;
  if not coalesce(v_allowed, false) then
    raise exception 'Trader has not shared trade history with this viewer' using errcode = '42501';
  end if;
  return query
  select t.id, t.symbol, lower(t.direction),
    case when t.closed_at is not null or lower(t.status) = 'closed' then 'closed' else 'open' end,
    t.opened_at, t.closed_at,
    case when t.closed_at is not null or lower(t.status) = 'closed' then t.profit else null end
  from public.trades t
  where t.user_id = p_trader_user_id
    and (lower(t.status) = 'open' or t.closed_at is not null or lower(t.status) = 'closed')
  order by coalesce(t.closed_at, t.opened_at) desc, t.id
  limit greatest(1, least(coalesce(p_limit, 100), 250));
end;
$$;

revoke all on function public.upsert_social_trader_review(uuid, integer, text) from public, anon;
revoke all on function public.delete_social_trader_review(uuid) from public, anon;
revoke all on function public.get_social_trader_reviews(uuid) from public, anon;
revoke all on function public.get_social_directory() from public, anon;
revoke all on function public.set_social_trade_history_sharing(boolean) from public, anon;
revoke all on function public.get_social_trade_history_access(uuid) from public, anon;
revoke all on function public.get_social_trade_history(uuid, integer) from public, anon;
grant execute on function public.upsert_social_trader_review(uuid, integer, text) to authenticated;
grant execute on function public.delete_social_trader_review(uuid) to authenticated;
grant execute on function public.get_social_trader_reviews(uuid) to authenticated;
grant execute on function public.get_social_directory() to authenticated;
grant execute on function public.set_social_trade_history_sharing(boolean) to authenticated;
grant execute on function public.get_social_trade_history_access(uuid) to authenticated;
grant execute on function public.get_social_trade_history(uuid, integer) to authenticated;
