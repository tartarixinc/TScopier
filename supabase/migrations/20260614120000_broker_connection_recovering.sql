-- Allow recovering status while the Connection Keeper hard-reconnects in the background.

alter table public.broker_accounts
  drop constraint if exists broker_accounts_connection_status_check;

alter table public.broker_accounts
  add constraint broker_accounts_connection_status_check
  check (connection_status in ('pending', 'connected', 'recovering', 'error'));

comment on column public.broker_accounts.connection_status is
  'pending | connected | recovering (auto-reconnect in progress) | error (needs user action)';
