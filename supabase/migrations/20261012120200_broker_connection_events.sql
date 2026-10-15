-- Durable MTAPI/FxSocket connection-transition log.
--
-- Problem it solves: broker_accounts.mtapi_status is overwritten in place, and
-- broker_write_leases rows are deleted on release, so before this table a
-- reconnect left no trace anywhere (the 2026-10-08 bridge outage could not be
-- reconstructed after the fact).
--
-- WRITER RULE (enforced below by a database trigger, not by application
-- code): a row is inserted ONLY when the status actually changed
-- (IS DISTINCT FROM). The MTAPI health sweep writes mtapi_status='connected'
-- every 240s per account (worker/src/mtapiSessionManager.ts syncAccountState);
-- without that guard this table would record connected->connected noise per
-- sweep per account and the mtapi_reconnect_storm alert rule would false-fire
-- on routine sweeps.
--
-- Retention: 90 days, pruned by 20261012120400_prune_monitoring_tables.sql.

CREATE TABLE IF NOT EXISTS broker_connection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_account_id uuid NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('fxsocket', 'mtapi')),
  field text NOT NULL DEFAULT 'connection_status' CHECK (field IN ('connection_status', 'mtapi_status')),
  from_status text,
  to_status text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_connection_events_created_idx
  ON broker_connection_events (created_at DESC);

CREATE INDEX IF NOT EXISTS broker_connection_events_account_created_idx
  ON broker_connection_events (broker_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS broker_connection_events_user_created_idx
  ON broker_connection_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

COMMENT ON TABLE broker_connection_events IS
  'Connection status transitions per broker account (only real changes, never same->same). 90-day retention. Feeds MTAPI reconnect history and the reconnect-storm alert.';
COMMENT ON COLUMN broker_connection_events.from_status IS
  'Previous status (connection_status or mtapi_status, whichever changed); NULL for the first observed state.';
COMMENT ON COLUMN broker_connection_events.reason IS
  'Short machine-readable cause when known (e.g. mtapi_reconnect, provider_transition, provision_failed, admin_forced_disconnect).';

ALTER TABLE broker_connection_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Transition-only writer (database trigger).
--
-- Enforcing "only real changes" in the database, not in application code,
-- means no future writer can forget the rule: the MTAPI health sweep updates
-- broker_accounts every 240s per account with the SAME status, and an
-- IS DISTINCT FROM guard makes those updates record nothing. One row is
-- inserted per status field that actually changed, so from_status/to_status
-- always describe a single field (see the field column).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_connection_events_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.connection_status IS DISTINCT FROM OLD.connection_status THEN
      INSERT INTO broker_connection_events
        (broker_account_id, user_id, provider, field, from_status, to_status)
      VALUES
        (NEW.id, NEW.user_id, COALESCE(NEW.provider, 'fxsocket'), 'connection_status',
         OLD.connection_status, NEW.connection_status);
    END IF;
    IF NEW.mtapi_status IS DISTINCT FROM OLD.mtapi_status THEN
      INSERT INTO broker_connection_events
        (broker_account_id, user_id, provider, field, from_status, to_status)
      VALUES
        (NEW.id, NEW.user_id, COALESCE(NEW.provider, 'mtapi'), 'mtapi_status',
         OLD.mtapi_status, NEW.mtapi_status);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.broker_connection_events_trigger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.broker_connection_events_trigger() TO service_role;

DROP TRIGGER IF EXISTS broker_connection_events_trg ON public.broker_accounts;
CREATE TRIGGER broker_connection_events_trg
  AFTER UPDATE ON public.broker_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.broker_connection_events_trigger();

COMMENT ON FUNCTION public.broker_connection_events_trigger() IS
  'AFTER UPDATE trigger on broker_accounts: appends a broker_connection_events row for each of connection_status / mtapi_status that actually changed (same->same writes record nothing).';
