/*
  # app_settings — global information banner

  Key/value style table for app-wide flags. Seeds the `banner_message` row:
  when `enabled` is true the app shows `message` in a banner at the top of
  the authenticated app.

  No insert/update/delete policies on purpose: only the service role (or the
  Supabase dashboard) can toggle the banner; clients are read-only.
*/

create table if not exists public.app_settings (
  key text primary key,
  enabled boolean not null default false,
  message text,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "Authenticated users can read app settings" on public.app_settings;
create policy "Authenticated users can read app settings"
  on public.app_settings for select
  to authenticated
  using (true);

comment on table public.app_settings is
  'App-wide flags. banner_message: when enabled, message is shown as an information banner at the top of the app.';

insert into public.app_settings (key, enabled, message)
values (
  'banner_message',
  true,
  'Maintenance Notice: The Worker is currently undergoing maintenance, signal copying might be unstable, please apply caution'
)
on conflict (key) do update
  set enabled = excluded.enabled,
      message = excluded.message,
      updated_at = now();

-- Realtime so the banner appears/disappears without a page refresh.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_settings'
  ) then
    execute 'alter publication supabase_realtime add table public.app_settings';
  end if;
end $$;
