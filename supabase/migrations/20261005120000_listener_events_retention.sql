-- listener_events retention + prune (2026-10-05 database-size incident).
--
-- Problem: listener_events had grown to 4.42 GB (84%) of an 8 GB disk with ~12M rows
-- and no retention policy. Six verbose diagnostic event types account for ~95% of rows
-- (signal_reconcile_checked alone: 8.0M rows since 2026-06-12).
--
-- Policy (age since created_at, by event_type):
--   7 days  — high-churn diagnostics (reconcile checks, poll/peer errors, ai skips)
--   30 days — investigation detail (mismatches, parse fallbacks, revisions, review rows)
--             also the DEFAULT for any event_type not listed below
--   90 days — rare incident/ops events (channel auto-disable, telegram link, assistant)
--
-- Prune runs batched (LIMIT'd CTE delete) so a single statement never holds a long
-- lock; scheduled hourly via pg_cron well above steady-state write rate (~100k rows/day).

CREATE OR REPLACE FUNCTION public.listener_events_retention_cutoff(p_event_type text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT now() - CASE
    WHEN p_event_type IN (
      'signal_reconcile_checked',
      'poll_peer_resolve_failed',
      'poll_error',
      'peer_resolve_failed',
      'signal_reconcile_parsed_drift',
      'ai_modification_skipped'
    ) THEN interval '7 days'
    WHEN p_event_type IN (
      'channel_invalid_detected',
      'channel_auto_disabled',
      'channel_reactivated',
      'telegram_link_attempt',
      'telegram_link_success',
      'telegram_link_failed',
      'telegram_link_disconnect',
      'assistant_tool_call'
    ) THEN interval '90 days'
    ELSE interval '30 days'
  END
$$;

COMMENT ON FUNCTION public.listener_events_retention_cutoff(text) IS
  'Retention policy for listener_events: 7 days for verbose diagnostics, 90 days for rare incident/ops events, 30 days (default) for everything else. Returns the timestamp before which rows of p_event_type are expired.';

CREATE OR REPLACE FUNCTION public.prune_listener_events(
  p_batch_rows integer DEFAULT 100000,
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
  IF p_batch_rows < 1000 THEN
    p_batch_rows := 100000;
  END IF;
  IF p_max_batches < 1 THEN
    p_max_batches := 10;
  END IF;

  LOOP
    WITH doomed AS MATERIALIZED (
      SELECT id
      FROM public.listener_events
      WHERE created_at < public.listener_events_retention_cutoff(event_type)
      LIMIT p_batch_rows
    )
    DELETE FROM public.listener_events le
    USING doomed d
    WHERE le.id = d.id;

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_deleted := v_deleted + v_batch;
    v_batches := v_batches + 1;
    EXIT WHEN v_batch < p_batch_rows OR v_batches >= p_max_batches;
  END LOOP;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_listener_events(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_listener_events(integer, integer) TO service_role;

COMMENT ON FUNCTION public.prune_listener_events(integer, integer) IS
  'Batched retention delete for listener_events: removes rows past their listener_events_retention_cutoff, p_batch_rows per statement, up to p_max_batches statements. Returns rows deleted. Safe to call repeatedly; scheduled hourly via pg_cron.';

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$ DECLARE v_jobid bigint; BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'prune-listener-events';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule('prune-listener-events', '41 * * * *', $cmd$
  SELECT public.prune_listener_events(100000, 20)
$cmd$);
