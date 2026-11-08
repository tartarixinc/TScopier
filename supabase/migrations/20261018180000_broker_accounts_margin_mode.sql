-- Margin/execution mode of a broker account (hedging vs netting).
--
-- Mirror copy must know this before it trusts open/close semantics: on a netting
-- account a second position on the same symbol merges into the first, so a naive
-- "open a copy" would be wrong. Defaults to 'unknown' (fail closed): the mirror
-- engine refuses to copy until the mode is known.
--
-- Written by the worker from the MT platform account summary, alongside
-- linked_account_type.

alter table public.broker_accounts
  add column if not exists margin_mode text not null default 'unknown'
  check (margin_mode in ('hedging', 'netting', 'unknown'));

comment on column public.broker_accounts.margin_mode is
  'Hedging vs netting execution mode, written by the worker from the MT platform account summary. unknown = not yet determined; mirror copy refuses to run until it is known.';

-- Table-level SELECT was revoked; grant the new column explicitly.
grant select (margin_mode) on public.broker_accounts to authenticated;

-- margin_mode is worker-owned: keep it read-only for authenticated/anon by extending the
-- existing credential guard trigger. The body below MUST reproduce the latest guard
-- (see 20261015140000_kucoin_broker_accounts.sql) verbatim, plus the margin_mode lines.
-- This migration runs last, so a partial body would silently drop protection for every
-- credential column added earlier (binance/bybit/kucoin/ctrader/mtapi).
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
    new.margin_mode := 'unknown';
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
    new.margin_mode := old.margin_mode;
  end if;
  return new;
end;
$$;
