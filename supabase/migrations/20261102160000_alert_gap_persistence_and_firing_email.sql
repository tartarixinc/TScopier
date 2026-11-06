-- Alert tuning from the 2026-11-02 System Health audit
-- (docs/scratchpads/scratchpad-system-health-alert-audit-2026-11-02.md).
--
-- 1. alert_events.firing_email_sent_at — when a firing-kind email was
--    accepted by Resend. email_sent_at is deliberately reset to NULL on
--    resolve so the recovery email can reuse the retry pass; that destroyed
--    the only record a page had ever been sent. This column is never reset,
--    so "paged at / recovered at" is queryable forever.
--
-- 2. alert_rules.cond_true_since / cond_false_since — persistence state for
--    rules whose threshold sets persistence_minutes > 0 (telegram_gap = 2).
--    The evaluator arms these columns and only opens/closes an event after
--    the condition has held/cleared for that many minutes, so one-tick
--    blips never reach the inbox (47 telegram_gap episodes in 5 days, almost
--    all ~1 minute). Rules without persistence_minutes keep the original
--    immediate behaviour and never write these columns.
--
-- 3. telegram_gap threshold.persistence_minutes = 2 — fire after 2 minutes
--    of continuous gap, resolve after 2 minutes of continuous clear.
--    The admin Alerts editor round-trips the whole threshold JSON, so the
--    key survives edits.

BEGIN;

ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS firing_email_sent_at timestamptz;
COMMENT ON COLUMN alert_events.firing_email_sent_at IS
  'When a firing-kind email was accepted by Resend. Never reset on resolve (unlike email_sent_at), so the page time survives the recovery email.';

ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS cond_true_since timestamptz;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS cond_false_since timestamptz;
COMMENT ON COLUMN alert_rules.cond_true_since IS
  'Persistence state: when the condition first held continuously. Only maintained for rules with threshold.persistence_minutes > 0. Null = not armed.';
COMMENT ON COLUMN alert_rules.cond_false_since IS
  'Persistence state: when the condition first cleared continuously while an event was open. Only maintained for rules with threshold.persistence_minutes > 0. Null = not armed.';

UPDATE alert_rules
SET threshold = (threshold || '{"persistence_minutes": 2}'::jsonb),
    updated_at = now()
WHERE code = 'telegram_gap'
  AND NOT (threshold ? 'persistence_minutes');

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261102160000', '20261102160000_alert_gap_persistence_and_firing_email')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verification: firing_email_sent_at present, cond_* present, telegram_gap
-- threshold contains persistence_minutes = 2.
SELECT 'alert_events.firing_email_sent_at' AS what, count(*) AS ok
FROM information_schema.columns
WHERE table_name = 'alert_events' AND column_name = 'firing_email_sent_at'
UNION ALL
SELECT 'alert_rules.cond_true_since', count(*)
FROM information_schema.columns
WHERE table_name = 'alert_rules' AND column_name = 'cond_true_since'
UNION ALL
SELECT 'alert_rules.cond_false_since', count(*)
FROM information_schema.columns
WHERE table_name = 'alert_rules' AND column_name = 'cond_false_since'
UNION ALL
SELECT 'telegram_gap persistence_minutes', count(*)
FROM alert_rules
WHERE code = 'telegram_gap' AND threshold ? 'persistence_minutes'
  AND (threshold->>'persistence_minutes')::numeric = 2;
