/*
  # app_settings — global announcement bar (teal)

  Seeds `announcement_message`: when `enabled` is true the app shows `message`
  in a teal announcement bar above the amber warning bar.
*/

insert into public.app_settings (key, enabled, message)
values (
  'announcement_message',
  false,
  'MT4 accounts are now supported — connect MetaTrader 4 from Account Configuration.'
)
on conflict (key) do nothing;

comment on table public.app_settings is
  'App-wide flags. banner_message: amber warning bar; announcement_message: teal announcement bar.';
