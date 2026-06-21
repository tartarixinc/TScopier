-- Idempotent cleanup: unschedule legacy broker edge crons if still present.
-- Primary drop is in 20260616120000_fxsocket_unify_broker_accounts.sql; this guards
-- environments where cron jobs were recreated or the earlier migration ran without pg_cron.

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  FOR v_jobid IN
    SELECT jobid FROM cron.job
    WHERE jobname IN (
      'broker-session-keepalive',
      'range-pending-sweep',
      'basket-sl-tp-sweep',
      'sync-mt-servers'
    )
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;
