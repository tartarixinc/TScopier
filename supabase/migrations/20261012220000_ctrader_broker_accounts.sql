-- cTrader Open API accounts. Tokens stay service-role only.

alter table public.broker_accounts
  drop constraint if exists broker_accounts_provider_check;

alter table public.broker_accounts
  add constraint broker_accounts_provider_check
    check (provider in ('fxsocket', 'mtapi', 'ctrader'));

comment on column public.broker_accounts.provider is
  'Broker provider: fxsocket (default), mtapi, or ctrader. Controls which BrokerProvider implementation handles this account.';

alter table public.broker_accounts
  add column if not exists ctrader_account_id text,
  add column if not exists ctrader_environment text,
  add column if not exists ctrader_access_token_encrypted text,
  add column if not exists ctrader_refresh_token_encrypted text,
  add column if not exists ctrader_token_expires_at timestamptz,
  add column if not exists ctrader_status text;

alter table public.broker_accounts
  drop constraint if exists broker_accounts_ctrader_environment_check;

alter table public.broker_accounts
  add constraint broker_accounts_ctrader_environment_check
    check (ctrader_environment is null or ctrader_environment in ('demo', 'live'));

alter table public.broker_accounts
  drop constraint if exists broker_accounts_ctrader_status_check;

alter table public.broker_accounts
  add constraint broker_accounts_ctrader_status_check
    check (ctrader_status is null or ctrader_status in ('connecting', 'connected', 'error', 'disconnected'));

comment on column public.broker_accounts.ctrader_account_id is
  'cTrader ctidTraderAccountId. Safe to show in the broker list.';
comment on column public.broker_accounts.ctrader_environment is
  'cTrader Open API host: demo or live.';
comment on column public.broker_accounts.ctrader_access_token_encrypted is
  'AES-256-GCM cTrader access token. Service-role only.';
comment on column public.broker_accounts.ctrader_refresh_token_encrypted is
  'AES-256-GCM cTrader refresh token. Service-role only.';
comment on column public.broker_accounts.ctrader_token_expires_at is
  'Access-token expiry. Service-role only.';
comment on column public.broker_accounts.ctrader_status is
  'cTrader link status shown in the Connection column.';

create unique index if not exists broker_accounts_ctrader_account_id_idx
  on public.broker_accounts (user_id, ctrader_account_id)
  where ctrader_account_id is not null and btrim(ctrader_account_id) <> '';

grant select (ctrader_account_id, ctrader_environment, ctrader_status)
  on public.broker_accounts to authenticated;

create or replace function public.broker_accounts_guard_mtapi_credentials()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  jwt_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  if jwt_role not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.mtapi_session_id := null;
    new.broker_password_encrypted := null;
    new.auto_reconnect_enabled := false;
    new.password_updated_at := null;
    new.ctrader_access_token_encrypted := null;
    new.ctrader_refresh_token_encrypted := null;
    new.ctrader_token_expires_at := null;
  else
    new.mtapi_session_id := old.mtapi_session_id;
    new.broker_password_encrypted := old.broker_password_encrypted;
    new.auto_reconnect_enabled := old.auto_reconnect_enabled;
    new.password_updated_at := old.password_updated_at;
    new.ctrader_access_token_encrypted := old.ctrader_access_token_encrypted;
    new.ctrader_refresh_token_encrypted := old.ctrader_refresh_token_encrypted;
    new.ctrader_token_expires_at := old.ctrader_token_expires_at;
  end if;
  return new;
end;
$$;
