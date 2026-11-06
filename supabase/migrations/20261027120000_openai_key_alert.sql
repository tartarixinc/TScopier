-- OpenAI API key rejected (authentication), as distinct from credits.
--
-- The alert-evaluator probes OpenAI every minute with a one-token request and
-- writes the outcome to system_probe_state target 'openai_api'. The existing
-- openai_credits_exhausted rule deliberately fires only on `billing:` details
-- (a revoked key must not be reported as "credits ran out"), which left auth
-- failures invisible: on 2026-10-24 06:56 UTC the production key was revoked
-- and every AI parse fell back to the regex engine for three days with no
-- email. This rule closes that gap by paging on `auth:` details (HTTP 401/403
-- invalid_api_key) and on a missing OPENAI_API_KEY environment variable.
--
-- Same probe row, same grace semantics as the credits rule: one transient
-- rejection does not page; a real outage stays down across ticks.
--
-- PREPARED: apply with a write-capable token on staging first, then
-- production, and register in supabase_migrations.schema_migrations.

INSERT INTO alert_rules (code, name, description, severity, threshold, window_minutes, cooldown_seconds)
VALUES (
  'openai_key_invalid',
  'OpenAI API key rejected',
  'OpenAI is refusing the configured API key (HTTP 401/403 invalid_api_key), or OPENAI_API_KEY is missing from the environment. AI signal parsing falls back to the deterministic regex engine, so signals the regex engine cannot read are skipped until a valid key is set. Separate from credits: this fires on authentication problems only.',
  'critical',
  '{"grace_seconds": 60}'::jsonb,
  1,
  300
)
ON CONFLICT (code) DO NOTHING;
