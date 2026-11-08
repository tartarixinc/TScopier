/*
  Provider onboarding — schema (phase 0 + 1).

  - Telegram becomes an allowed public profile link.
  - social_profiles gains a stable public slug, a provider_status and a bio.
  - social_copy_sources gains an account snapshot (kind, platform, balance, equity,
    currency) that is refreshed server-side from broker_accounts.
  - provider_applications holds the onboarding draft and the admin review decision.
  - Existing providers (profiles that already own copy sources) are grandfathered
    as approved so nothing disappears from the directory.
*/

-- 1. Public profile links: add Telegram -------------------------------------------------
create or replace function public.social_profile_links_are_valid(p_links jsonb)
returns boolean
language sql immutable set search_path = pg_catalog as $$
  select jsonb_typeof(coalesce(p_links, '{}'::jsonb)) = 'object'
    and not exists (
      select 1 from jsonb_each(coalesce(p_links, '{}'::jsonb)) entry
      where entry.key not in ('x', 'instagram', 'telegram', 'linkedin', 'youtube', 'tiktok', 'facebook')
        or jsonb_typeof(entry.value) <> 'string'
        or length(entry.value #>> '{}') > 500
        or not (
          (entry.key = 'x' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*(x\.com|twitter\.com)/[^[:space:]]+$')
          or (entry.key = 'instagram' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*instagram\.com/[^[:space:]]+$')
          or (entry.key = 'telegram' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*(t\.me|telegram\.me|telegram\.org)/[^[:space:]]+$')
          or (entry.key = 'linkedin' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*linkedin\.com/[^[:space:]]+$')
          or (entry.key = 'youtube' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*(youtube\.com|youtu\.be)/[^[:space:]]+$')
          or (entry.key = 'tiktok' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*tiktok\.com/[^[:space:]]+$')
          or (entry.key = 'facebook' and (entry.value #>> '{}') ~* '^https://([a-z0-9-]+\.)*facebook\.com/[^[:space:]]+$')
        )
    );
$$;

-- 2. social_profiles: slug, provider status, bio ---------------------------------------
alter table public.social_profiles
  add column if not exists slug text,
  add column if not exists provider_status text not null default 'none',
  add column if not exists bio text;

alter table public.social_profiles drop constraint if exists social_profiles_provider_status_check;
alter table public.social_profiles add constraint social_profiles_provider_status_check
  check (provider_status in ('none', 'pending', 'approved', 'rejected', 'suspended'));

alter table public.social_profiles drop constraint if exists social_profiles_bio_length;
alter table public.social_profiles add constraint social_profiles_bio_length
  check (bio is null or char_length(bio) <= 500);

create or replace function public.social_generate_slug(p_user_id uuid)
returns text
language plpgsql set search_path = pg_catalog, public as $$
declare
  v_base text;
  v_candidate text;
  v_n integer := 0;
begin
  select lower(regexp_replace(
    coalesce(nullif(btrim(up.username), ''), nullif(btrim(up.display_name), ''), ''),
    '[^a-zA-Z0-9]+', '-', 'g'))
  into v_base
  from public.user_profiles up
  where up.user_id = p_user_id;

  v_base := btrim(coalesce(v_base, ''), '-');
  v_base := btrim(left(v_base, 32), '-');
  if char_length(v_base) < 3 then
    v_base := 'trader-' || substr(replace(p_user_id::text, '-', ''), 1, 6);
  end if;

  v_candidate := v_base;
  while exists (
    select 1 from public.social_profiles sp where sp.slug = v_candidate and sp.user_id <> p_user_id
  ) loop
    v_n := v_n + 1;
    v_candidate := left(v_base, 30) || '-' || v_n::text;
  end loop;
  return v_candidate;
end;
$$;

create or replace function public.social_profiles_assign_slug()
returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.slug is null then
    new.slug := public.social_generate_slug(new.user_id);
  end if;
  return new;
end;
$$;

drop trigger if exists social_profiles_assign_slug on public.social_profiles;
create trigger social_profiles_assign_slug
  before insert on public.social_profiles
  for each row execute function public.social_profiles_assign_slug();

update public.social_profiles sp
set slug = public.social_generate_slug(sp.user_id)
where sp.slug is null;

alter table public.social_profiles alter column slug set not null;
alter table public.social_profiles drop constraint if exists social_profiles_slug_format;
alter table public.social_profiles add constraint social_profiles_slug_format
  check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');
create unique index if not exists social_profiles_slug_key on public.social_profiles (slug);

-- Grandfather every existing provider: profiles that already own a copy source.
update public.social_profiles sp
set provider_status = 'approved'
where sp.provider_status = 'none'
  and exists (select 1 from public.social_copy_sources s where s.trader_user_id = sp.user_id);

-- 3. social_copy_sources: account snapshot ---------------------------------------------
alter table public.social_copy_sources
  add column if not exists account_kind text,
  add column if not exists platform text,
  add column if not exists snapshot_balance numeric,
  add column if not exists snapshot_equity numeric,
  add column if not exists snapshot_currency text,
  add column if not exists snapshot_at timestamptz;

alter table public.social_copy_sources drop constraint if exists social_copy_sources_account_kind_check;
alter table public.social_copy_sources add constraint social_copy_sources_account_kind_check
  check (account_kind is null or account_kind in ('demo', 'live', 'prop', 'unknown'));

-- 4. provider_applications --------------------------------------------------------------
create table if not exists public.provider_applications (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'approved', 'rejected', 'suspended')),
  broker_account_id uuid references public.broker_accounts(id) on delete set null,
  declared_account_kind text check (declared_account_kind is null or declared_account_kind in ('demo', 'live', 'prop')),
  prop_firm_name text check (prop_firm_name is null or char_length(prop_firm_name) between 2 and 80),
  monthly_price_cents integer check (monthly_price_cents is null or monthly_price_cents between 0 and 10000000),
  access_mode text not null default 'open' check (access_mode in ('open', 'private')),
  bio text check (bio is null or char_length(bio) <= 500),
  social_links jsonb not null default '{}'::jsonb check (public.social_profile_links_are_valid(social_links)),
  terms_accepted_at timestamptz,
  submit_count integer not null default 0,
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists provider_applications_status_idx
  on public.provider_applications (status, submitted_at);

alter table public.provider_applications enable row level security;

drop policy if exists provider_applications_owner_select on public.provider_applications;
create policy provider_applications_owner_select on public.provider_applications
  for select to authenticated using (user_id = auth.uid());

drop policy if exists provider_applications_admin_select on public.provider_applications;
create policy provider_applications_admin_select on public.provider_applications
  for select to authenticated using (public.is_admin());

-- Writes only happen through security-definer RPCs; there are no insert/update/delete policies.
revoke all on public.provider_applications from anon, authenticated;
grant select on public.provider_applications to authenticated;

comment on table public.provider_applications is
  'Provider onboarding drafts and admin review decisions. Mutated only through save_provider_draft / submit_provider_application / admin_review_provider_application.';

-- 5. Notification event types for the review outcome ----------------------------------
alter table public.in_app_notifications drop constraint if exists in_app_notifications_event_type_check;
alter table public.in_app_notifications add constraint in_app_notifications_event_type_check
  check (event_type in (
    'social_follow_accepted', 'social_copy_activated', 'social_copy_stopped', 'social_copy_suspended',
    'provider_application_approved', 'provider_application_rejected',
    'provider_suspended', 'provider_reinstated'
  ));
