-- Retention pruner for the monitoring tables + the alert-evaluator cron.
--
-- Volumes (steady state): system_probe_events ~dozens/day (flips only),
-- system_probe_samples ~2074/day (2 targets x 60s), broker_connection_events
-- tens/day (transitions only), alert_events a few/day. The pruner exists so
-- nothing grows without bound, matching the repo's established pattern
-- (20261005120000_listener_events_retention.sql).

CREATE OR REPLACE FUNCTION public.prune_monitoring_tables(
  p_batch_rows integer DEFAULT 50000,
  p_max_batches integer DEFAULT 10
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
  v_batch integer;
  v_batches integer := 0;
BEGIN
  IF p_batch_rows < 1000 THEN p_batch_rows := 50000; END IF;
  IF p_max_batches < 1 THEN p_max_batches := 10; END IF;

  LOOP
    WITH doomed AS MATERIALIZED (
      SELECT id FROM system_probe_events WHERE created_at < now() - interval '30 days' LIMIT p_batch_rows
    )
    DELETE FROM system_probe_events e USING doomed d WHERE e.id = d.id;
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_deleted := v_deleted + v_batch;
    v_batches := v_batches + 1;
    EXIT WHEN v_batch < p_batch_rows OR v_batches >= p_max_batches;
  END LOOP;

  v_batches := 0;
  LOOP
    WITH doomed AS MATERIALIZED (
      SELECT id FROM system_probe_samples WHERE created_at < now() - interval '30 days' LIMIT p_batch_rows
    )
    DELETE FROM system_probe_samples s USING doomed d WHERE s.id = d.id;
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_deleted := v_deleted + v_batch;
    v_batches := v_batches + 1;
    EXIT WHEN v_batch < p_batch_rows OR v_batches >= p_max_batches;
  END LOOP;

  v_batches := 0;
  LOOP
    WITH doomed AS MATERIALIZED (
      SELECT id FROM broker_connection_events WHERE created_at < now() - interval '90 days' LIMIT p_batch_rows
    )
    DELETE FROM broker_connection_events b USING doomed d WHERE b.id = d.id;
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_deleted := v_deleted + v_batch;
    v_batches := v_batches + 1;
    EXIT WHEN v_batch < p_batch_rows OR v_batches >= p_max_batches;
  END LOOP;

  v_batches := 0;
  LOOP
    WITH doomed AS MATERIALIZED (
      SELECT id FROM alert_events WHERE created_at < now() - interval '90 days' LIMIT p_batch_rows
    )
    DELETE FROM alert_events a USING doomed d WHERE a.id = d.id;
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_deleted := v_deleted + v_batch;
    v_batches := v_batches + 1;
    EXIT WHEN v_batch < p_batch_rows OR v_batches >= p_max_batches;
  END LOOP;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_monitoring_tables(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_monitoring_tables(integer, integer) TO service_role;

COMMENT ON FUNCTION public.prune_monitoring_tables(integer, integer) IS
  'Batched retention delete: probe events/samples 30 days, broker connection events and alert events 90 days. Returns rows deleted.';

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$ DECLARE v_jobid bigint; BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'prune-monitoring-tables';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule('prune-monitoring-tables', '43 * * * *', $cmd$
  SELECT public.prune_monitoring_tables(50000, 10)
$cmd$);

-- Alert evaluator: every minute. Pattern copied from
-- 20260921120000_disconnect_expired_fxsocket_brokers.sql — fire-and-forget
-- net.http_post; the evaluator's own liveness is tracked in
-- system_probe_state (target='alert_evaluator') + a Sentry cron check-in,
-- because cron history cannot see a failing HTTP call.
DO $$ DECLARE v_jobid bigint; BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'alert-evaluator';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule('alert-evaluator', '* * * * *', $cmd$
DO $$ DECLARE v_url text := current_setting('app.settings.supabase_url', true); v_key text := current_setting('app.settings.service_role_key', true); BEGIN
IF v_url IS NULL OR v_key IS NULL OR length(trim(v_url)) = 0 OR length(trim(v_key)) = 0 THEN RAISE NOTICE 'Skipping alert-evaluator: missing app settings'; RETURN; END IF;
PERFORM net.http_post(url := v_url || '/functions/v1/alert-evaluator', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key), body := '{}'::jsonb, timeout_milliseconds := 55000); END $$;
$cmd$);
