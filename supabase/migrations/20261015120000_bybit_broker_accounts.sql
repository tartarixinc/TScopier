-- Bybit V5 linear futures accounts. API key and secret stay service-role only.
-- Margin mode is account-wide on a Unified account, so it is read live and not stored.

alter table public.broker_accounts
  drop constraint if exists broker_accounts_provider_check;

alter table public.broker_accounts
  add constraint broker_accounts_provider_check
    check (provider in ('fxsocket', 'mtapi', 'ctrader', 'binance', 'bybit'));

comment on column public.broker_accounts.provider is
  'Broker provider: fxsocket (default), mtapi, ctrader, binance, or bybit. Controls which BrokerProvider implementation handles this account.';

alter table public.broker_accounts
  add column if not exists bybit_account_id text,
  add column if not exists bybit_environment text,
  add column if not exists bybit_api_key_encrypted text,
  add column if not exists bybit_api_secret_encrypted text,
  add column if not exists bybit_status text,
  add column if not exists bybit_margin_usdt numeric,
  add column if not exists bybit_leverage integer;

alter table public.broker_accounts
  drop constraint if exists broker_accounts_bybit_environment_check;
alter table public.broker_accounts
  add constraint broker_accounts_bybit_environment_check
    check (bybit_environment is null or bybit_environment in ('demo', 'live'));

alter table public.broker_accounts
  drop constraint if exists broker_accounts_bybit_status_check;
alter table public.broker_accounts
  add constraint broker_accounts_bybit_status_check
    check (bybit_status is null or bybit_status in ('connecting', 'connected', 'error', 'disconnected'));

alter table public.broker_accounts
  drop constraint if exists broker_accounts_bybit_leverage_check;
alter table public.broker_accounts
  add constraint broker_accounts_bybit_leverage_check
    check (bybit_leverage is null or (bybit_leverage between 1 and 125));

alter table public.broker_accounts
  drop constraint if exists broker_accounts_bybit_margin_usdt_check;
alter table public.broker_accounts
  add constraint broker_accounts_bybit_margin_usdt_check
    check (bybit_margin_usdt is null or bybit_margin_usdt > 0);

comment on column public.broker_accounts.bybit_account_id is
  'Stable id for the linked Bybit key (API key fingerprint). Safe to show in the broker list.';
comment on column public.broker_accounts.bybit_environment is
  'Bybit host: demo (api-demo.bybit.com) or live (api.bybit.com).';
comment on column public.broker_accounts.bybit_api_key_encrypted is
  'AES-256-GCM Bybit API key. Service-role only.';
comment on column public.broker_accounts.bybit_api_secret_encrypted is
  'AES-256-GCM Bybit API secret. Service-role only.';
comment on column public.broker_accounts.bybit_status is
  'Bybit link status shown in the Connection column.';
comment on column public.broker_accounts.bybit_margin_usdt is
  'Quote-currency margin committed to each copied signal. Position notional is margin times leverage.';
comment on column public.broker_accounts.bybit_leverage is
  'Leverage applied to the symbol before each order (1-125, capped by the symbol maximum).';

create unique index if not exists broker_accounts_bybit_account_id_idx
  on public.broker_accounts (user_id, bybit_account_id)
  where bybit_account_id is not null and btrim(bybit_account_id) <> '';

grant select (
  bybit_account_id,
  bybit_environment,
  bybit_status,
  bybit_margin_usdt,
  bybit_leverage
) on public.broker_accounts to authenticated;

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
    new.ctrader_client_id_encrypted := null;
    new.ctrader_client_secret_encrypted := null;
    new.binance_api_key_encrypted := null;
    new.binance_api_secret_encrypted := null;
    new.binance_account_id := null;
    new.binance_margin_usdt := null;
    new.binance_leverage := null;
    new.binance_margin_mode := null;
    new.bybit_api_key_encrypted := null;
    new.bybit_api_secret_encrypted := null;
    new.bybit_account_id := null;
    new.bybit_margin_usdt := null;
    new.bybit_leverage := null;
  else
    new.mtapi_session_id := old.mtapi_session_id;
    new.broker_password_encrypted := old.broker_password_encrypted;
    new.auto_reconnect_enabled := old.auto_reconnect_enabled;
    new.password_updated_at := old.password_updated_at;
    new.ctrader_access_token_encrypted := old.ctrader_access_token_encrypted;
    new.ctrader_refresh_token_encrypted := old.ctrader_refresh_token_encrypted;
    new.ctrader_token_expires_at := old.ctrader_token_expires_at;
    new.ctrader_client_id_encrypted := old.ctrader_client_id_encrypted;
    new.ctrader_client_secret_encrypted := old.ctrader_client_secret_encrypted;
    new.binance_api_key_encrypted := old.binance_api_key_encrypted;
    new.binance_api_secret_encrypted := old.binance_api_secret_encrypted;
    new.binance_account_id := old.binance_account_id;
    new.binance_margin_usdt := old.binance_margin_usdt;
    new.binance_leverage := old.binance_leverage;
    new.binance_margin_mode := old.binance_margin_mode;
    new.bybit_api_key_encrypted := old.bybit_api_key_encrypted;
    new.bybit_api_secret_encrypted := old.bybit_api_secret_encrypted;
    new.bybit_account_id := old.bybit_account_id;
    new.bybit_margin_usdt := old.bybit_margin_usdt;
    new.bybit_leverage := old.bybit_leverage;
  end if;
  return new;
end;
$$;

-- Write lease: let the copy worker fence Bybit accounts.
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'broker_write_leases'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%provider%';
  if constraint_name is not null then
    execute format('alter table public.broker_write_leases drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.broker_write_leases
  drop constraint if exists broker_write_leases_provider_check;

alter table public.broker_write_leases
  add constraint broker_write_leases_provider_check
    check (provider in ('fxsocket', 'mtapi', 'ctrader', 'binance', 'bybit'));

create or replace function public.acquire_broker_write_lease(
  p_broker_account_id uuid,
  p_expected_provider text,
  p_expected_session_id text,
  p_expected_writer_epoch bigint,
  p_operation text,
  p_ttl_seconds integer default 120
)
returns table(lease_id uuid, writer_epoch bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  account_row public.broker_accounts%rowtype;
  authoritative_session text;
  new_lease_id uuid;
begin
  if p_expected_provider not in ('fxsocket', 'mtapi', 'ctrader', 'binance', 'bybit')
    or nullif(btrim(coalesce(p_expected_session_id, '')), '') is null
    or p_expected_writer_epoch is null
    or nullif(btrim(coalesce(p_operation, '')), '') is null then
    raise exception using errcode = 'P0001', message = 'BROKER_WRITE_FENCE_REJECTED';
  end if;

  select * into account_row
  from public.broker_accounts
  where id = p_broker_account_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'BROKER_WRITE_FENCE_REJECTED';
  end if;

  authoritative_session := case account_row.provider
    when 'mtapi' then nullif(btrim(account_row.mtapi_session_id), '')
    when 'ctrader' then nullif(btrim(account_row.ctrader_account_id), '')
    when 'binance' then nullif(btrim(account_row.binance_account_id), '')
    when 'bybit' then nullif(btrim(account_row.bybit_account_id), '')
    else coalesce(
      nullif(btrim(account_row.fxsocket_account_id), ''),
      nullif(btrim(account_row.metaapi_account_id), '')
    )
  end;

  if account_row.provider_transition_state <> 'stable'
    or account_row.provider <> p_expected_provider
    or account_row.writer_epoch <> p_expected_writer_epoch
    or authoritative_session is distinct from btrim(p_expected_session_id) then
    raise exception using errcode = 'P0001', message = 'BROKER_WRITE_FENCE_REJECTED';
  end if;

  delete from public.broker_write_leases
  where broker_account_id = p_broker_account_id and expires_at <= clock_timestamp();

  insert into public.broker_write_leases (
    broker_account_id, writer_epoch, provider, operation, expires_at
  ) values (
    p_broker_account_id,
    account_row.writer_epoch,
    account_row.provider,
    left(btrim(p_operation), 80),
    clock_timestamp() + make_interval(secs => greatest(10, least(p_ttl_seconds, 300)))
  ) returning id into new_lease_id;

  return query select new_lease_id, account_row.writer_epoch;
end;
$$;
