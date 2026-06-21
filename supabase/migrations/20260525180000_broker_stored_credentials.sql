-- Optional encrypted MT password for automatic reconnect when the FxSocket session is fully gone.
-- Ciphertext is readable only by service_role; clients may read auto_reconnect_enabled for UI state.

alter table public.broker_accounts
  add column if not exists mt_password_encrypted text;

alter table public.broker_accounts
  add column if not exists auto_reconnect_enabled boolean not null default false;

alter table public.broker_accounts
  add column if not exists password_updated_at timestamptz;

comment on column public.broker_accounts.mt_password_encrypted is
  'AES-256-GCM ciphertext of MT password. Writable only via service_role (edge). Never returned to browsers.';

comment on column public.broker_accounts.auto_reconnect_enabled is
  'When true and mt_password_encrypted is set, edge/worker may ConnectEx without user prompt on hard session loss.';

comment on column public.broker_accounts.password_updated_at is
  'When mt_password_encrypted was last written or refreshed.';

-- Hide ciphertext from authenticated clients (SELECT * omits columns without privilege).
revoke select on table public.broker_accounts from authenticated;

grant select (
  id,
  user_id,
  label,
  platform,
  metaapi_account_id,
  account_login,
  broker_name,
  broker_server,
  connection_status,
  last_balance,
  last_equity,
  last_currency,
  last_synced_at,
  performance_baseline_balance,
  day_start_balance,
  day_start_balance_on,
  is_active,
  copier_mode,
  signal_channel_ids,
  enforce_signal_channel_filter,
  ai_settings,
  manual_settings,
  channel_message_filters,
  default_lot_size,
  pip_tolerance,
  max_trades_per_zone,
  created_at,
  updated_at,
  last_activated_at,
  auto_reconnect_enabled,
  password_updated_at
) on table public.broker_accounts to authenticated;

-- Block client JWT writes to credential columns; edge uses service_role.
create or replace function public.broker_accounts_guard_credentials()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_user = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.mt_password_encrypted := null;
    new.auto_reconnect_enabled := false;
    new.password_updated_at := null;
  elsif tg_op = 'UPDATE' then
    new.mt_password_encrypted := old.mt_password_encrypted;
    new.auto_reconnect_enabled := old.auto_reconnect_enabled;
    new.password_updated_at := old.password_updated_at;
  end if;

  return new;
end;
$$;

drop trigger if exists broker_accounts_guard_credentials on public.broker_accounts;

create trigger broker_accounts_guard_credentials
  before insert or update on public.broker_accounts
  for each row
  execute function public.broker_accounts_guard_credentials();
