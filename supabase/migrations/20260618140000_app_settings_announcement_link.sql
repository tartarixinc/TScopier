/*
  # app_settings — optional link on announcement bar

  link_href: internal path (/brokers) or external URL (https://…)
  link_label: link text (defaults to "Click here" in the app when href is set)
*/

alter table public.app_settings
  add column if not exists link_href text,
  add column if not exists link_label text;

update public.app_settings
set
  link_href = '/brokers',
  link_label = 'Click here'
where key = 'announcement_message'
  and link_href is null;
