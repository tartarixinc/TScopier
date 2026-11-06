-- MatchTrader accounts. Each trader links their own Match-Trader login (platform URL, email, password).
-- Match-Trader is white-label, so every broker hosts its own platform URL; it is validated as public
-- https before any request. The password stays service-role only.
--
-- Match-Trader writes carry no client order id or comment, so the worker keeps the signal comment of
-- each order it opens in matchtrader_order_tags (service-role only) and re-attaches it when reading.

alter table public.broker_accounts
  drop constraint if exists broker_accounts_provider_check;

alter table public.broker_accounts
  add constraint broker_accounts_provider_check
    check (provider in ('fxsocket', 'mtapi', 'ctrader', 'binance', 'bybit', 'kucoin', 'dxtrade', 'tradelocker', 'matchtrader'));

comment on column public.broker_accounts.provider is
  'Broker provider: fxsocket (default), mtapi, ctrader, binance, bybit, kucoin, dxtrade, tradelocker, or matchtrader. Controls which BrokerProvider implementation handles this account.';

alter table public.broker_accounts
  add column if not exists matchtrader_account_id text,
  add column if not exists matchtrader_server_url text,
  add column if not exists matchtrader_broker_id text,
  add column if not exists matchtrader_email text,
  add column if not exists matchtrader_password_encrypted text,
  add column if not exists matchtrader_trading_account_uuid text,
  add column if not exists matchtrader_system_uuid text,
  add column if not exists matchtrader_status text;

alter table public.broker_accounts
  drop constraint if exists broker_accounts_matchtrader_status_check;
alter table public.broker_accounts
  add constraint broker_accounts_matchtrader_status_check
    check (matchtrader_status is null or matchtrader_status in ('connecting', 'connected', 'error', 'disconnected'));

comment on column public.broker_accounts.matchtrader_account_id is
  'Stable id for the linked Match-Trader account (fingerprint of platform host, broker id, email and trading account). Safe to show in the broker list.';
comment on column public.broker_accounts.matchtrader_server_url is
  'Validated https platform URL of the broker Match-Trader server (for example https://mtr-demo-prod.match-trader.com).';
comment on column public.broker_accounts.matchtrader_broker_id is
  'Match-Trader brokerId / partnerId sent on login.';
comment on column public.broker_accounts.matchtrader_email is
  'Match-Trader login email.';
comment on column public.broker_accounts.matchtrader_password_encrypted is
  'AES-256-GCM Match-Trader password. Service-role only.';
comment on column public.broker_accounts.matchtrader_trading_account_uuid is
  'Match-Trader trading account uuid selected at link time.';
comment on column public.broker_accounts.matchtrader_system_uuid is
  'Match-Trader system uuid (the SYSTEM_UUID path segment of /mtr-api/{systemUuid}/...).';
comment on column public.broker_accounts.matchtrader_status is
  'Match-Trader link status shown in the Connection column.';

create unique index if not exists broker_accounts_matchtrader_account_id_idx
  on public.broker_accounts (user_id, matchtrader_account_id)
  where matchtrader_account_id is not null and btrim(matchtrader_account_id) <> '';

grant select (
  matchtrader_account_id,
  matchtrader_server_url,
  matchtrader_broker_id,
  matchtrader_email,
  matchtrader_trading_account_uuid,
  matchtrader_system_uuid,
  matchtrader_status
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
    new.kucoin_api_key_encrypted := null;
    new.kucoin_api_secret_encrypted := null;
    new.kucoin_passphrase_encrypted := null;
    new.kucoin_account_id := null;
    new.kucoin_margin_usdt := null;
    new.kucoin_leverage := null;
    new.kucoin_margin_mode := null;
    new.dxtrade_password_encrypted := null;
    new.dxtrade_account_id := null;
    new.dxtrade_server_url := null;
    new.dxtrade_username := null;
    new.dxtrade_domain := null;
    new.dxtrade_account_code := null;
    new.dxtrade_is_position_based := null;
    new.tradelocker_password_encrypted := null;
    new.tradelocker_account_id := null;
    new.tradelocker_environment := null;
    new.tradelocker_server := null;
    new.tradelocker_email := null;
    new.tradelocker_account_ref := null;
    new.tradelocker_acc_num := null;
    new.matchtrader_password_encrypted := null;
    new.matchtrader_account_id := null;
    new.matchtrader_server_url := null;
    new.matchtrader_broker_id := null;
    new.matchtrader_email := null;
    new.matchtrader_trading_account_uuid := null;
    new.matchtrader_system_uuid := null;
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
    new.kucoin_api_key_encrypted := old.kucoin_api_key_encrypted;
    new.kucoin_api_secret_encrypted := old.kucoin_api_secret_encrypted;
    new.kucoin_passphrase_encrypted := old.kucoin_passphrase_encrypted;
    new.kucoin_account_id := old.kucoin_account_id;
    new.kucoin_margin_usdt := old.kucoin_margin_usdt;
    new.kucoin_leverage := old.kucoin_leverage;
    new.kucoin_margin_mode := old.kucoin_margin_mode;
    new.dxtrade_password_encrypted := old.dxtrade_password_encrypted;
    new.dxtrade_account_id := old.dxtrade_account_id;
    new.dxtrade_server_url := old.dxtrade_server_url;
    new.dxtrade_username := old.dxtrade_username;
    new.dxtrade_domain := old.dxtrade_domain;
    new.dxtrade_account_code := old.dxtrade_account_code;
    new.dxtrade_is_position_based := old.dxtrade_is_position_based;
    new.tradelocker_password_encrypted := old.tradelocker_password_encrypted;
    new.tradelocker_account_id := old.tradelocker_account_id;
    new.tradelocker_environment := old.tradelocker_environment;
    new.tradelocker_server := old.tradelocker_server;
    new.tradelocker_email := old.tradelocker_email;
    new.tradelocker_account_ref := old.tradelocker_account_ref;
    new.tradelocker_acc_num := old.tradelocker_acc_num;
    new.matchtrader_password_encrypted := old.matchtrader_password_encrypted;
    new.matchtrader_account_id := old.matchtrader_account_id;
    new.matchtrader_server_url := old.matchtrader_server_url;
    new.matchtrader_broker_id := old.matchtrader_broker_id;
    new.matchtrader_email := old.matchtrader_email;
    new.matchtrader_trading_account_uuid := old.matchtrader_trading_account_uuid;
    new.matchtrader_system_uuid := old.matchtrader_system_uuid;
  end if;
  return new;
end;
$$;

-- Write lease: let the copy worker fence Match-Trader accounts.
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
    check (provider in ('fxsocket', 'mtapi', 'ctrader', 'binance', 'bybit', 'kucoin', 'dxtrade', 'tradelocker', 'matchtrader'));

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
  if p_expected_provider not in ('fxsocket', 'mtapi', 'ctrader', 'binance', 'bybit', 'kucoin', 'dxtrade', 'tradelocker', 'matchtrader')
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
    when 'kucoin' then nullif(btrim(account_row.kucoin_account_id), '')
    when 'dxtrade' then nullif(btrim(account_row.dxtrade_account_id), '')
    when 'tradelocker' then nullif(btrim(account_row.tradelocker_account_id), '')
    when 'matchtrader' then nullif(btrim(account_row.matchtrader_account_id), '')
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

-- Signal comment of each order the worker opened on a Match-Trader account (the API has no comment field).
create table if not exists public.matchtrader_order_tags (
  broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  order_id text not null,
  comment text not null,
  symbol text,
  side text,
  created_at timestamptz not null default now(),
  primary key (broker_account_id, order_id)
);

create index if not exists matchtrader_order_tags_created_idx
  on public.matchtrader_order_tags (broker_account_id, created_at desc);

alter table public.matchtrader_order_tags enable row level security;
revoke all on public.matchtrader_order_tags from anon, authenticated;
grant select, insert, update, delete on public.matchtrader_order_tags to service_role;

comment on table public.matchtrader_order_tags is
  'Signal comment per Match-Trader order id. Service-role only; Match-Trader writes have no comment field.';
