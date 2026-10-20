-- OpenAI credits exhausted.
--
-- The alert-evaluator probes OpenAI every minute with a one-token request and
-- writes the outcome to system_probe_state target 'openai_api'. This rule turns
-- a billing-coded failure (429 credit_balance_exhausted / insufficient_quota /
-- a reached spend limit) into a critical page.
--
-- Why probe instead of reading Railway logs: OpenAI returns these codes only
-- when a request is made. Waiting for a customer signal would delay the alert
-- until parsing had already stopped, and the Railway log reader needs a token
-- that is not configured in production. The probe costs a fraction of a cent
-- per day and also feeds the admin Systems Health page.
--
-- grace_seconds keeps one transient 429 from paging; the evaluator writes the
-- same down state on every run, so a real outage remains down across ticks.

INSERT INTO alert_rules (code, name, description, severity, threshold, window_minutes, cooldown_seconds)
VALUES (
  'openai_credits_exhausted',
  'OpenAI credits exhausted',
  'OpenAI is refusing API requests because the organization has no prepaid credits left or a spend limit has been reached. AI signal parsing stops and only the regex parser runs, so complex signals may be missed until credits are added.',
  'critical',
  '{"grace_seconds": 60}'::jsonb,
  1,
  300
)
ON CONFLICT (code) DO NOTHING;
