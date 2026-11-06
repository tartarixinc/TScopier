/*
  # landing_announcements — the announcement tag in the marketing hero

  Public (anon-readable) because the landing page is shown to signed-out visitors.
  The page shows the newest row that is active and inside its optional start/end window,
  so publishing news is just inserting a row (and `is_active = false` or `ends_at` retires one).

  - message:      default text (shown when there is no translation for the visitor's locale)
  - translations: optional {"es": "...", "fr": "..."} overrides, keyed by locale code
  - link_href:    optional internal path (/pricing) or external URL; makes the tag clickable
  - link_label:   optional accessible label for the link

  No insert/update/delete policies on purpose: only the service role (or the Supabase
  dashboard / SQL editor) can publish announcements; clients are read-only.
*/

create table if not exists public.landing_announcements (
  id uuid primary key default gen_random_uuid(),
  message text not null check (length(btrim(message)) > 0),
  translations jsonb not null default '{}'::jsonb,
  link_href text,
  link_label text,
  is_active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists landing_announcements_live_idx
  on public.landing_announcements (starts_at desc)
  where is_active;

alter table public.landing_announcements enable row level security;

drop policy if exists "Anyone can read live landing announcements" on public.landing_announcements;
create policy "Anyone can read live landing announcements"
  on public.landing_announcements for select
  to anon, authenticated
  using (is_active and starts_at <= now() and (ends_at is null or ends_at > now()));

comment on table public.landing_announcements is
  'Marketing hero announcement tag. The newest active row inside its starts_at/ends_at window is shown.';

insert into public.landing_announcements (message, translations)
select
  'TScopier.ai is now UniCopier',
  jsonb_build_object(
    'es', 'TScopier.ai ahora es UniCopier',
    'fr', 'TScopier.ai devient UniCopier',
    'ar', 'أصبح TScopier.ai الآن UniCopier',
    'ja', 'TScopier.aiは UniCopier になりました',
    'nl', 'TScopier.ai is nu UniCopier',
    'pl', 'TScopier.ai to teraz UniCopier',
    'ru', 'TScopier.ai теперь UniCopier',
    'sv', 'TScopier.ai är nu UniCopier'
  )
where not exists (select 1 from public.landing_announcements);
