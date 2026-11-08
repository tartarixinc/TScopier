-- Production-backed Social Follow foundation.
--
-- Authenticated user ids are the only social identities. public.user_profiles
-- remains private; the directory RPC below exposes only the named safe fields.

create table if not exists public.social_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_mode text not null default 'open'
    check (access_mode in ('open', 'private')),
  is_listed boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.social_profiles is
  'Explicit opt-in to the social directory. Public identity remains sourced from the private user_profiles row through narrow RPCs.';

create table if not exists public.social_follow_relationships (
  id uuid primary key default gen_random_uuid(),
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  followed_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint social_follow_relationships_not_self
    check (follower_user_id <> followed_user_id),
  constraint social_follow_relationships_pair_unique
    unique (follower_user_id, followed_user_id)
);

comment on table public.social_follow_relationships is
  'One canonical outgoing relationship per user pair. Private profiles begin pending; open profiles are accepted immediately.';

create index if not exists social_follow_relationships_followed_status_idx
  on public.social_follow_relationships (followed_user_id, status);

create index if not exists social_follow_relationships_follower_status_idx
  on public.social_follow_relationships (follower_user_id, status);

create or replace function public.set_social_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists social_profiles_updated_at on public.social_profiles;
create trigger social_profiles_updated_at
  before update on public.social_profiles
  for each row execute function public.set_social_updated_at();

drop trigger if exists social_follow_relationships_updated_at on public.social_follow_relationships;
create trigger social_follow_relationships_updated_at
  before update on public.social_follow_relationships
  for each row execute function public.set_social_updated_at();

alter table public.social_profiles enable row level security;
alter table public.social_follow_relationships enable row level security;

drop policy if exists "Users can view own social profile registration" on public.social_profiles;
create policy "Users can view own social profile registration"
  on public.social_profiles for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Participants can view their social relationships" on public.social_follow_relationships;
create policy "Participants can view their social relationships"
  on public.social_follow_relationships for select
  to authenticated
  using (auth.uid() = follower_user_id or auth.uid() = followed_user_id);

-- Direct browser writes are intentionally unavailable. All actor-sensitive
-- mutations below derive the actor from auth.uid().
revoke all on table public.social_profiles from anon, authenticated;
revoke all on table public.social_follow_relationships from anon, authenticated;
grant select on table public.social_profiles to authenticated;
grant select on table public.social_follow_relationships to authenticated;
grant all on table public.social_profiles to service_role;
grant all on table public.social_follow_relationships to service_role;

create or replace function public.social_follow_actor_is_verified(p_actor uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from auth.users au
    join public.user_profiles up on up.user_id = au.id
    where au.id = p_actor
      and case
        when public.auth_user_is_oauth(au)
          or (coalesce(au.raw_app_meta_data->>'provider', '') <> '' and au.raw_app_meta_data->>'provider' <> 'email')
        then au.email_confirmed_at is not null
        else up.email_verified_at is not null
      end
  );
$$;

create or replace function public.social_follow_profile_is_eligible(p_actor uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.social_profiles sp
    join public.user_profiles up on up.user_id = sp.user_id
    where sp.user_id = p_actor
      and sp.is_listed = true
      and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
  );
$$;

create or replace function public.guard_listed_social_profile_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(nullif(btrim(new.display_name), ''), nullif(btrim(new.username), '')) is null
    and exists (
      select 1
      from public.social_profiles sp
      where sp.user_id = new.user_id
        and sp.is_listed = true
    )
  then
    raise exception 'A listed social profile requires a display name or username'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists user_profiles_social_identity_guard on public.user_profiles;
create trigger user_profiles_social_identity_guard
  before update of display_name, username on public.user_profiles
  for each row execute function public.guard_listed_social_profile_identity();

create or replace function public.register_social_profile()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_has_public_identity boolean;
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Social Follow requires a verified account' using errcode = '42501';
  end if;

  select coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
    into v_has_public_identity
  from public.user_profiles up
  where up.user_id = v_actor;

  if not coalesce(v_has_public_identity, false) then
    raise exception 'Complete your display name or username before joining the social directory'
      using errcode = 'check_violation';
  end if;

  insert into public.social_profiles (user_id)
  values (v_actor)
  on conflict (user_id) do update
    set is_listed = true;
end;
$$;

create or replace function public.set_social_profile_access(p_access_mode text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Social Follow requires a verified account' using errcode = '42501';
  end if;
  if p_access_mode not in ('open', 'private') then
    raise exception 'Invalid social profile access mode' using errcode = '22023';
  end if;

  update public.social_profiles
  set access_mode = p_access_mode
  where user_id = v_actor;

  if not found then
    raise exception 'Social profile is not registered' using errcode = 'P0002';
  end if;

  -- Once an owner becomes open, outstanding requests no longer require manual
  -- approval. Existing accepted followers remain accepted when becoming private.
  if p_access_mode = 'open' then
    update public.social_follow_relationships
    set status = 'accepted', responded_at = now()
    where followed_user_id = v_actor
      and status = 'pending';
  end if;
end;
$$;

create or replace function public.follow_social_profile(p_profile_user_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_access_mode text;
  v_status text;
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Social Follow requires a verified account' using errcode = '42501';
  end if;
  if not public.social_follow_profile_is_eligible(v_actor) then
    raise exception 'Following requires a registered, listed social profile with a public identity'
      using errcode = '55000';
  end if;
  if p_profile_user_id is null then
    raise exception 'Profile user id is required' using errcode = '22004';
  end if;
  if p_profile_user_id = v_actor then
    raise exception 'Users cannot follow themselves' using errcode = 'check_violation';
  end if;

  select sp.access_mode into v_access_mode
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  where sp.user_id = p_profile_user_id
    and sp.is_listed = true
    and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
  for update of sp;

  if v_access_mode is null then
    raise exception 'Social profile is not available' using errcode = 'P0002';
  end if;

  v_status := case when v_access_mode = 'open' then 'accepted' else 'pending' end;

  insert into public.social_follow_relationships (
    follower_user_id,
    followed_user_id,
    status,
    responded_at
  ) values (
    v_actor,
    p_profile_user_id,
    v_status,
    case when v_status = 'accepted' then now() else null end
  )
  on conflict (follower_user_id, followed_user_id) do update
  set status = case
        when public.social_follow_relationships.status = 'accepted' then 'accepted'
        else excluded.status
      end,
      responded_at = case
        when public.social_follow_relationships.status = 'accepted' then public.social_follow_relationships.responded_at
        when excluded.status = 'accepted' then now()
        else null
      end;

  select sfr.status into v_status
  from public.social_follow_relationships sfr
  where sfr.follower_user_id = v_actor
    and sfr.followed_user_id = p_profile_user_id;

  return v_status;
end;
$$;

create or replace function public.remove_social_follow(p_profile_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Social Follow requires a verified account' using errcode = '42501';
  end if;

  delete from public.social_follow_relationships
  where follower_user_id = v_actor
    and followed_user_id = p_profile_user_id;
end;
$$;

create or replace function public.resolve_social_follow_request(
  p_follower_user_id uuid,
  p_decision text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not public.social_follow_actor_is_verified(v_actor) then
    raise exception 'Social Follow requires a verified account' using errcode = '42501';
  end if;
  if p_decision not in ('accepted', 'declined') then
    raise exception 'Invalid follow request decision' using errcode = '22023';
  end if;

  update public.social_follow_relationships
  set status = p_decision,
      responded_at = now()
  where follower_user_id = p_follower_user_id
    and followed_user_id = v_actor
    and status = 'pending';

  if not found then
    raise exception 'Pending follow request was not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.get_social_directory()
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
  follows_viewer_status text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  return query
  select
    sp.user_id,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) as display_name,
    coalesce(nullif(btrim(up.username), ''), '') as username,
    coalesce(nullif(btrim(up.country), ''), '') as country,
    sp.access_mode,
    sp.user_id = v_actor as is_self,
    (
      select count(*)
      from public.social_follow_relationships incoming
      join public.social_profiles incoming_profile on incoming_profile.user_id = incoming.follower_user_id
      join public.user_profiles incoming_identity on incoming_identity.user_id = incoming.follower_user_id
      where incoming.followed_user_id = sp.user_id
        and incoming.status = 'accepted'
        and incoming_profile.is_listed = true
        and coalesce(nullif(btrim(incoming_identity.display_name), ''), nullif(btrim(incoming_identity.username), '')) is not null
    ) as follower_count,
    (
      select count(*)
      from public.social_follow_relationships outgoing_count
      join public.social_profiles followed_profile on followed_profile.user_id = outgoing_count.followed_user_id
      join public.user_profiles followed_identity on followed_identity.user_id = outgoing_count.followed_user_id
      where outgoing_count.follower_user_id = sp.user_id
        and outgoing_count.status = 'accepted'
        and followed_profile.is_listed = true
        and coalesce(nullif(btrim(followed_identity.display_name), ''), nullif(btrim(followed_identity.username), '')) is not null
    ) as following_count,
    outgoing.status as viewer_relationship_status,
    incoming_viewer.status as follows_viewer_status
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  left join public.social_follow_relationships outgoing
    on outgoing.follower_user_id = v_actor
   and outgoing.followed_user_id = sp.user_id
  left join public.social_follow_relationships incoming_viewer
    on incoming_viewer.follower_user_id = sp.user_id
   and incoming_viewer.followed_user_id = v_actor
  where sp.is_listed = true
    and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
  order by 7 desc, 2 asc, 1 asc;
end;
$$;

revoke all on function public.set_social_updated_at() from public, anon, authenticated;
revoke all on function public.social_follow_actor_is_verified(uuid) from public, anon, authenticated;
revoke all on function public.social_follow_profile_is_eligible(uuid) from public, anon, authenticated;
revoke all on function public.guard_listed_social_profile_identity() from public, anon, authenticated;
revoke all on function public.register_social_profile() from public, anon;
revoke all on function public.set_social_profile_access(text) from public, anon;
revoke all on function public.follow_social_profile(uuid) from public, anon;
revoke all on function public.remove_social_follow(uuid) from public, anon;
revoke all on function public.resolve_social_follow_request(uuid, text) from public, anon;
revoke all on function public.get_social_directory() from public, anon;

grant execute on function public.register_social_profile() to authenticated;
grant execute on function public.set_social_profile_access(text) to authenticated;
grant execute on function public.follow_social_profile(uuid) to authenticated;
grant execute on function public.remove_social_follow(uuid) to authenticated;
grant execute on function public.resolve_social_follow_request(uuid, text) to authenticated;
grant execute on function public.get_social_directory() to authenticated;

