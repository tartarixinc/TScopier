-- Alerting tables: rules (editable thresholds), fired events with delivery
-- tracking, and email recipients. Evaluated by the alert-evaluator edge
-- function every minute (cron scheduled in 20261012120400_prune_monitoring_tables.sql).
--
-- Design notes:
--  * Thresholds live HERE, not in code, so the admin UI editor and the
--    evaluator always use the same numbers. The evaluator reads them on every
--    run; the Systems Health page reads them for the new check tiles.
--  * alert_events enforces ONE open firing event per rule with a partial
--    unique index. The evaluator plain-inserts and treats a 23505 on insert
--    as a lost race (an overlapping cron tick already fired) and sends nothing.
--  * email_sent_at / email_attempts track delivery. The evaluator retries
--    unsent firing events each tick (exponential backoff via
--    email_next_attempt_at) so a transient Resend failure cannot silently
--    swallow a page: firing emails retry indefinitely, and only recovery
--    (resolved) emails give up after 5 attempts.
--  * The evaluator cannot page about its own death. Production MUST set
--    SENTRY_AUTH_TOKEN + ALERT_EVALUATOR_CRON_MONITOR_SLUG (external cron
--    monitor) — a dead evaluator means no rule runs at all. The seeded
--    probe_stale rule also watches the evaluator's own probe row, so a
--    recovery after an outage pages with what happened.
--  * All writes from the admin app (rule edits, recipients, acknowledge) go
--    through the admin-mutate edge function (service role + audit). These
--    tables carry no authenticated INSERT/UPDATE policies by design.

CREATE TABLE IF NOT EXISTS alert_rules (
  code text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  enabled boolean NOT NULL DEFAULT true,
  threshold jsonb NOT NULL DEFAULT '{}'::jsonb,
  window_minutes integer NOT NULL DEFAULT 5 CHECK (window_minutes > 0),
  cooldown_seconds integer NOT NULL DEFAULT 900 CHECK (cooldown_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE alert_rules IS
  'Server-side alert rules with editable thresholds. Read by alert-evaluator and the Systems Health page so screen and email cannot disagree.';

CREATE TABLE IF NOT EXISTS alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_code text NOT NULL REFERENCES alert_rules(code) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('firing', 'resolved', 'acknowledged')),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  value numeric,
  message text NOT NULL,
  email_sent_at timestamptz,
  email_attempts integer NOT NULL DEFAULT 0 CHECK (email_attempts >= 0),
  email_last_error text,
  email_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one open firing event per rule (the dedupe/race guard).
CREATE UNIQUE INDEX IF NOT EXISTS alert_events_open_firing_idx
  ON alert_events (rule_code)
  WHERE state = 'firing';

CREATE INDEX IF NOT EXISTS alert_events_created_idx
  ON alert_events (created_at DESC);

CREATE INDEX IF NOT EXISTS alert_events_state_created_idx
  ON alert_events (state, created_at DESC);

COMMENT ON TABLE alert_events IS
  'Alert lifecycle per rule: firing -> resolved (or acknowledged). Partial unique index guarantees one open firing row per rule. 90-day retention.';
COMMENT ON COLUMN alert_events.email_sent_at IS
  'When the firing (or resolution) email was accepted by Resend. NULL = undelivered; the evaluator retries with exponential backoff (firing events retry indefinitely, recovery events up to 5 attempts).';
COMMENT ON COLUMN alert_events.email_next_attempt_at IS
  'Earliest time the next delivery attempt may run (backoff written by the evaluator). Also the claim token: an evaluator run must move this field forward with a compare-and-set before sending, so overlapping cron ticks cannot double-send.';

CREATE TABLE IF NOT EXISTS alert_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  min_severity text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info', 'warning', 'critical')),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE alert_recipients IS
  'Ops email recipients for alert firing/resolution notices, with a minimum severity filter.';

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_recipients ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Seed rules. window_minutes/cooldown are conservative starting points; tune
-- from the admin Alerts page after the first week on staging.
-- ---------------------------------------------------------------------------
INSERT INTO alert_rules (code, name, description, severity, threshold, window_minutes, cooldown_seconds) VALUES
  (
    'bridge_down',
    'MTAPI bridge down',
    'A bridge target (MT5 or MT4) has been failing its health check for longer than the grace period. Copies through MTAPI cannot execute while this fires.',
    'critical',
    '{"grace_seconds": 120, "targets": ["bridge_mt5", "bridge_mt4"]}'::jsonb,
    5, 900
  ),
  (
    'probe_stale',
    'Probe not reporting',
    'A probe row has not been updated for longer than the grace period: a bridge target (MT5 or MT4) or the alert evaluator itself stopped reporting. Unknown must never be treated as healthy. The evaluator row also pages on recovery after an outage, since a dead evaluator cannot send mail while it is down.',
    'warning',
    '{"max_stale_minutes": 5, "targets": ["bridge_mt5", "bridge_mt4", "alert_evaluator"]}'::jsonb,
    5, 900
  ),
  (
    'mtapi_accounts_error',
    'MTAPI accounts failing',
    'Too many MTAPI broker accounts currently show an error status. Indicates a bridge or MTAPI-side problem rather than isolated user issues.',
    'critical',
    '{"max_error_pct": 20, "min_accounts": 3}'::jsonb,
    15, 1800
  ),
  (
    'mtapi_reconnect_storm',
    'MTAPI reconnect storm',
    'Connection status changes are happening far more often than normal, which usually means accounts are flapping between connected and error.',
    'warning',
    '{"max_events": 10}'::jsonb,
    15, 1800
  ),
  (
    'workers_offline',
    'No workers online',
    'No worker process holds an unexpired lease. Nothing is listening or copying.',
    'critical',
    '{}'::jsonb,
    5, 600
  ),
  (
    'trade_workers_offline',
    'Trade workers offline',
    'No trade worker has reported liveness recently. Trade workers hold no session leases (they are not Telegram listeners), so they heartbeat target worker_trade through the probe RPC every 60s; a stale row means every trade worker is gone. Listeners may still run, but nothing can execute or probe the bridge.',
    'critical',
    '{"max_stale_minutes": 3}'::jsonb,
    5, 600
  ),
  (
    'queue_stuck',
    'Signal queue stuck',
    'Parsed signals are waiting too long without being executed, or the pending backlog is too large.',
    'critical',
    '{"max_oldest_minutes": 60, "max_pending": 10}'::jsonb,
    5, 900
  ),
  (
    'executions_failing',
    'Executions failing',
    'The count of failed execution log rows in the window is above the threshold. Coarse by design: reason-code classification stays in the dashboard, not duplicated here.',
    'warning',
    '{"max_failed": 20}'::jsonb,
    60, 3600
  ),
  (
    'dead_letters_high',
    'Dead letters piling up',
    'Queue messages that failed repeatedly are parked for manual replay. A growing count means the pipeline cannot deliver.',
    'critical',
    '{"max_open": 20}'::jsonb,
    15, 1800
  ),
  (
    'telegram_gap',
    'Telegram listening gaps',
    'Linked Telegram accounts without an active listener. Affected users are not being copied.',
    'warning',
    '{"max_not_listening": 2}'::jsonb,
    15, 1800
  )
ON CONFLICT (code) DO NOTHING;

COMMENT ON COLUMN alert_rules.threshold IS
  'Rule-specific parameters as JSON. Keys are documented per rule in the alert-evaluator source (supabase/functions/alert-evaluator).';
