-- The credential guard must also keep `broker_accounts.margin_mode` worker-owned.
--
-- `20261018180000_broker_accounts_margin_mode.sql` added the two assignments that
-- pin that column on client writes. Three later migrations (`20261019090000`
-- dxtrade, `20261019120000` tradelocker, `20261020100000` match-trader) each
-- reproduced the whole guard body to add their own columns — and every one of
-- them dropped those two lines, so the function that is actually live no longer
-- mentions `margin_mode` at all (verified against the live function body: it is
-- byte-identical to the match-trader version).
--
-- Practical exposure is limited — `authenticated` only holds a column-scoped
-- `update (copy_source)` grant on `broker_accounts`, and privilege checks run
-- before triggers — but the defence in depth is gone, and mirror copy now *reads*
-- this column to decide whether a slave account may be copied onto at all, so a
-- client that could write it would be writing a safety gate.
--
-- The body below is the live body (the match-trader version) verbatim, plus the
-- two `margin_mode` lines. Nothing else changes: reproducing anything less would
-- silently drop protection for the columns the later migrations added.

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
    new.margin_mode := old.margin_mode;
  end if;
  return new;
end;
$$;