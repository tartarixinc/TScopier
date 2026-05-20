-- Security hardening: RPC execute grants, SECURITY DEFINER search_path, telegram_auth_pending lockdown.
-- Performance: indexes aligned with dashboard + worker hot paths.

-- ---------------------------------------------------------------------------
-- telegram_auth_pending — worker-only (phone hash, partial MTProto session)
-- RLS was enabled with no policies; revoke table privileges from client roles.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE public.telegram_auth_pending FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.telegram_auth_pending TO service_role;

COMMENT ON TABLE public.telegram_auth_pending IS
  'Worker-only Telegram login state between send_code and verify_code/2FA. Not exposed to clients.';

-- ---------------------------------------------------------------------------
-- search_path hardening (trigger helpers + LATERAL extract used by backtest RPCs)
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.set_user_profiles_updated_at()
  SET search_path = public;

ALTER FUNCTION public.extract_channel_trade_signal_row(public.signals)
  SET search_path = public;

-- ---------------------------------------------------------------------------
-- Revoke unintended RPC / trigger function EXECUTE from PUBLIC
-- (service_role retains access where explicitly granted; triggers run as owner)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.extract_channel_trade_signal_row(public.signals) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.extract_channel_trade_signal_row(public.signals) TO service_role;

REVOKE ALL ON FUNCTION public.trg_prune_trade_execution_logs() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.set_user_profiles_updated_at() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.delete_backtest_channel_signals_outside_range(
  uuid, uuid[], timestamptz, timestamptz, text[]
) FROM PUBLIC;

-- Idempotent: these were already locked down in prior migrations; re-apply for drift.
REVOKE ALL ON FUNCTION public.prune_trade_execution_logs(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_trade_execution_logs(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.upsert_backtest_channel_signal(
  uuid, uuid, uuid, text, text, text, text, numeric, numeric, numeric[], numeric, text, jsonb, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_backtest_channel_signal(
  uuid, uuid, uuid, text, text, text, text, numeric, numeric, numeric[], numeric, text, jsonb, timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.refresh_backtest_channel_signals(uuid, uuid[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_backtest_channel_signals(uuid, uuid[], timestamptz, timestamptz) TO service_role;

GRANT EXECUTE ON FUNCTION public.delete_backtest_channel_signals_outside_range(
  uuid, uuid[], timestamptz, timestamptz, text[]
) TO service_role;

-- Drop superseded RPC if an older migration partially applied.
DROP FUNCTION IF EXISTS public.refresh_channel_trade_signals(uuid, uuid[], timestamptz, timestamptz);

-- ---------------------------------------------------------------------------
-- Performance indexes (dashboard + worker)
-- ---------------------------------------------------------------------------

-- Dashboard: linked brokers per user, ordered by created_at
CREATE INDEX IF NOT EXISTS idx_broker_accounts_user_created_at
  ON public.broker_accounts (user_id, created_at DESC);

-- Worker: heartbeat / loadBrokers scan active accounts only
CREATE INDEX IF NOT EXISTS idx_broker_accounts_is_active_true
  ON public.broker_accounts (id)
  WHERE is_active = true;

-- Dashboard: recent signals + today/yesterday counts by created_at window
CREATE INDEX IF NOT EXISTS idx_signals_user_created_at
  ON public.signals (user_id, created_at DESC);

-- Worker: executor sweep for parsed signals in a time window
CREATE INDEX IF NOT EXISTS idx_signals_parsed_created_at
  ON public.signals (created_at DESC)
  WHERE status = 'parsed';

-- Dashboard: active channel list per user
CREATE INDEX IF NOT EXISTS idx_telegram_channels_user_active
  ON public.telegram_channels (user_id)
  WHERE is_active = true;
