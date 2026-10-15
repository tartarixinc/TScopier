-- Bridge probe transition history: one row only when a target flips
-- up -> down or down -> up. Steady state writes nothing, so volume is
-- approximately zero (a flapping bridge produces a few dozen rows/day).
--
-- Latency samples live in system_probe_samples (separate table, sampled
-- every Nth poll) so uptime/latency charts have data without a row per poll
-- here. Retention: 30 days, pruned by 20261012120400_prune_monitoring_tables.sql.

CREATE TABLE IF NOT EXISTS system_probe_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL,
  state text NOT NULL CHECK (state IN ('up', 'down')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_probe_events_created_idx
  ON system_probe_events (created_at DESC);

CREATE INDEX IF NOT EXISTS system_probe_events_target_created_idx
  ON system_probe_events (target, created_at DESC);

COMMENT ON TABLE system_probe_events IS
  'State transitions per probe target (up/down flips only). 30-day retention.';

ALTER TABLE system_probe_events ENABLE ROW LEVEL SECURITY;
