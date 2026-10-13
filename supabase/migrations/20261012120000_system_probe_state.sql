-- Bridge probe state: one row per probe target, upserted by the worker's
-- bridge probe (worker/src/observability/bridgeProbe.ts).
--
-- Targets are the two MTAPI bridge containers as reached through nginx:
--   bridge_mt5  -> GET /health      (asserted 200 by deploy/mt4-bridge/05-nginx.sh)
--   bridge_mt4  -> GET /mt4/Ping    (asserted 200 by deploy/mt4-bridge/05-nginx.sh)
-- The bare container path /Ping is NOT publicly served and must not be probed.
--
-- The row is always updated in place (never appended), so this table holds
-- exactly one row per target and does not grow. History lives in
-- system_probe_events (transitions only) and in the latency sample rows.
--
-- target = 'alert_evaluator' is reserved: the alert-evaluator edge function
-- upserts it on every successful run, so the admin page can show evaluator
-- staleness (the dead-man's switch surface). It is never probed over HTTP.

CREATE TABLE IF NOT EXISTS system_probe_state (
  target text PRIMARY KEY,
  state text NOT NULL DEFAULT 'unknown' CHECK (state IN ('up', 'down', 'unknown')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  last_ok_at timestamptz,
  down_since timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE system_probe_state IS
  'Current state per probe target (bridge_mt5, bridge_mt4, alert_evaluator). One row per target, upserted in place; never grows.';
COMMENT ON COLUMN system_probe_state.down_since IS
  'First observed failure of the current down run; NULL while up/unknown. Drives the bridge_down grace period.';
COMMENT ON COLUMN system_probe_state.updated_at IS
  'Last probe or evaluator run. Staleness (updated_at older than 3x the expected interval) must be treated as unknown, never as up.';

ALTER TABLE system_probe_state ENABLE ROW LEVEL SECURITY;

-- Latency/uptime samples: one row per target per sample interval (default
-- once a minute) so the admin page can draw 24h uptime % and p95 latency.
-- Transition-only history has no samples to chart; one row per poll here is
-- ~1440 rows/target/day (~86k rows/target at the 30-day retention), trivial.
CREATE TABLE IF NOT EXISTS system_probe_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target text NOT NULL,
  state text NOT NULL CHECK (state IN ('up', 'down')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_probe_samples_target_created_idx
  ON system_probe_samples (target, created_at DESC);

CREATE INDEX IF NOT EXISTS system_probe_samples_created_idx
  ON system_probe_samples (created_at DESC);

COMMENT ON TABLE system_probe_samples IS
  'Periodic probe results for uptime/latency charts (one row per target per sample, default every 60s). 30-day retention.';

ALTER TABLE system_probe_samples ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Atomic probe-result writer.
--
-- The worker calls this on every probe tick. It is compare-and-set under a
-- row lock, so two replicas probing the same target cannot double-insert a
-- transition event or disagree about the current state: only the caller that
-- observes the flip inserts the event.
--
-- Sampling is throttled here (at most one sample row per target per 55s), so
-- the probe can call this every tick without a row per poll, and the cadence
-- stays correct even if the poll interval changes.
--
-- SECURITY DEFINER + grant to service_role only: this is the single writer
-- API for probe data; nothing else needs to execute it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_probe_result(
  p_target text,
  p_state text,
  p_latency_ms integer,
  p_detail text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev text;
  v_flipped boolean := false;
  v_now timestamptz := now();
BEGIN
  IF p_state NOT IN ('up', 'down', 'unknown') THEN
    RAISE EXCEPTION 'invalid probe state %', p_state;
  END IF;

  SELECT state INTO v_prev
  FROM system_probe_state
  WHERE target = p_target
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO system_probe_state (target, state, latency_ms, last_ok_at, down_since, consecutive_failures, detail, updated_at)
    VALUES (
      p_target,
      p_state,
      p_latency_ms,
      CASE WHEN p_state = 'up' THEN v_now END,
      CASE WHEN p_state = 'down' THEN v_now END,
      CASE WHEN p_state = 'down' THEN 1 ELSE 0 END,
      p_detail,
      v_now
    );
    -- First observation: record the event only when it is already down —
    -- bootstrapping an 'up' row is not a transition worth charting.
    v_flipped := (p_state = 'down');
    IF v_flipped THEN
      INSERT INTO system_probe_events (target, state, latency_ms, detail)
      VALUES (p_target, 'down', p_latency_ms, p_detail);
    END IF;
  ELSE
    UPDATE system_probe_state
    SET state = p_state,
        latency_ms = p_latency_ms,
        last_ok_at = CASE WHEN p_state = 'up' THEN v_now ELSE last_ok_at END,
        down_since = CASE
          WHEN p_state = 'down' AND v_prev <> 'down' THEN v_now
          WHEN p_state = 'down' THEN down_since
          ELSE NULL
        END,
        consecutive_failures = CASE
          WHEN p_state = 'down' THEN consecutive_failures + 1
          ELSE 0
        END,
        detail = p_detail,
        updated_at = v_now
    WHERE target = p_target;

    IF v_prev IS DISTINCT FROM p_state AND p_state IN ('up', 'down') AND v_prev IN ('up', 'down') THEN
      v_flipped := true;
      INSERT INTO system_probe_events (target, state, latency_ms, detail)
      VALUES (p_target, p_state, p_latency_ms, p_detail);
    END IF;
  END IF;

  -- At most one sample row per target per 55 seconds.
  IF p_state IN ('up', 'down') AND NOT EXISTS (
    SELECT 1 FROM system_probe_samples
    WHERE target = p_target AND created_at > v_now - interval '55 seconds'
  ) THEN
    INSERT INTO system_probe_samples (target, state, latency_ms, created_at)
    VALUES (p_target, p_state, p_latency_ms, v_now);
  END IF;

  RETURN v_flipped;
END;
$$;

REVOKE ALL ON FUNCTION public.record_probe_result(text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_probe_result(text, text, integer, text) TO service_role;

COMMENT ON FUNCTION public.record_probe_result(text, text, integer, text) IS
  'Atomic upsert of a probe result: transitions to/from up/down append exactly one system_probe_events row under a row lock (safe for concurrent probers); throttles latency samples to one per target per 55s. Returns true when a transition was recorded.';

-- Writers are service-role only (worker + edge function); the admin dashboard
-- reads through an is_admin() policy added in the tscopier-admin migrations.
-- No authenticated SELECT policy here by design: default Supabase table
-- privileges grant SELECT to authenticated, so RLS with zero policies = no rows
-- until the admin policy lands, which is the intended behaviour.
