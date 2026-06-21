-- FxSocket migration: unify broker_accounts, deactivate MT4, drop legacy broker infra.

-- FxSocket terminal UUID (replaces metaapi_account_id for live API calls).
ALTER TABLE public.broker_accounts
  ADD COLUMN IF NOT EXISTS fxsocket_account_id text NOT NULL DEFAULT '';

ALTER TABLE public.broker_accounts
  ADD COLUMN IF NOT EXISTS fxsocket_status text NOT NULL DEFAULT 'disconnected'
    CHECK (fxsocket_status IN ('connecting', 'connected', 'error', 'disconnected'));

ALTER TABLE public.broker_accounts
  ADD COLUMN IF NOT EXISTS terminal_connected boolean;

ALTER TABLE public.broker_accounts
  ADD COLUMN IF NOT EXISTS trade_allowed boolean;

ALTER TABLE public.broker_accounts
  ADD COLUMN IF NOT EXISTS connection_error text;

COMMENT ON COLUMN public.broker_accounts.fxsocket_account_id IS
  'FxSocket terminal UUID (api.fxsocket.com/mt5/{id}/...).';

COMMENT ON COLUMN public.broker_accounts.fxsocket_status IS
  'FxSocket v1 account status: connecting | connected | error | disconnected.';

-- Backfill fxsocket_account_id from legacy ConnectEx UUID (valid MT5 session ids).
UPDATE public.broker_accounts
SET fxsocket_account_id = metaapi_account_id,
    fxsocket_status = CASE
      WHEN connection_status = 'connected' THEN 'connected'
      WHEN connection_status = 'recovering' THEN 'connecting'
      WHEN connection_status = 'error' THEN 'error'
      ELSE 'disconnected'
    END
WHERE coalesce(fxsocket_account_id, '') = ''
  AND metaapi_account_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Merge sandbox fxsocket_broker_accounts into broker_accounts (skip duplicates).
INSERT INTO public.broker_accounts (
  user_id,
  label,
  platform,
  fxsocket_account_id,
  account_login,
  broker_server,
  fxsocket_status,
  connection_status,
  connection_error,
  last_balance,
  last_equity,
  last_currency,
  last_synced_at,
  terminal_connected,
  trade_allowed,
  is_active,
  default_lot_size,
  pip_tolerance,
  max_trades_per_zone
)
SELECT
  f.user_id,
  f.label,
  'MT5',
  f.fxsocket_account_id,
  f.account_login,
  f.broker_server,
  f.connection_status,
  CASE f.connection_status
    WHEN 'connected' THEN 'connected'
    WHEN 'connecting' THEN 'pending'
    WHEN 'error' THEN 'error'
    ELSE 'pending'
  END,
  f.connection_error,
  f.last_balance,
  f.last_equity,
  f.last_currency,
  f.last_synced_at,
  f.terminal_connected,
  f.trade_allowed,
  true,
  0.01,
  5,
  3
FROM public.fxsocket_broker_accounts f
WHERE f.fxsocket_account_id <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.broker_accounts b
    WHERE b.user_id = f.user_id
      AND b.fxsocket_account_id = f.fxsocket_account_id
  );

-- Deactivate MT4 accounts (FxSocket v1 is MT5-only).
UPDATE public.broker_accounts
SET is_active = false,
    fxsocket_status = 'error',
    connection_status = 'error',
    connection_error = 'MT4 is no longer supported. Reconnect as MT5 via FxSocket.'
WHERE upper(platform) = 'MT4'
  AND is_active = true;

-- Force MT5-only platform going forward.
UPDATE public.broker_accounts SET platform = 'MT5' WHERE upper(platform) = 'MT5';

CREATE UNIQUE INDEX IF NOT EXISTS broker_accounts_user_fxsocket_id_idx
  ON public.broker_accounts (user_id, fxsocket_account_id)
  WHERE fxsocket_account_id <> '';

-- Drop legacy cron jobs.
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job
    WHERE jobname IN (
      'broker-session-keepalive',
      'range-pending-sweep',
      'basket-sl-tp-sweep'
    )
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

-- Drop legacy connect-lock table (ConnectEx serialization no longer needed).
DROP TABLE IF EXISTS public.mt_server_connect_locks;

-- Drop sandbox table after merge.
DROP TABLE IF EXISTS public.fxsocket_broker_accounts CASCADE;

-- Drop stored-credential columns (FxSocket stores passwords).
ALTER TABLE public.broker_accounts DROP COLUMN IF EXISTS mt_password_encrypted;
ALTER TABLE public.broker_accounts DROP COLUMN IF EXISTS auto_reconnect_enabled;
ALTER TABLE public.broker_accounts DROP COLUMN IF EXISTS password_updated_at;
ALTER TABLE public.broker_accounts DROP COLUMN IF EXISTS connection_error_kind;
ALTER TABLE public.broker_accounts DROP COLUMN IF EXISTS connection_error_message;

-- Keep metaapi_account_id for migration reference; drop metaapi_order_id rename deferred.
COMMENT ON COLUMN public.broker_accounts.metaapi_account_id IS
  'DEPRECATED: legacy mt4api session UUID. Use fxsocket_account_id.';
