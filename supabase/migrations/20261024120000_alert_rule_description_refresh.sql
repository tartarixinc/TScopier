-- Alert rule descriptions follow the evaluator semantics changed in
-- supabase/functions/alert-evaluator (2026-10-23 review).
--
-- PREPARED, NOT APPLIED: run manually with a write-capable token (the
-- reviewing agent's token is read-only), AFTER deploying the updated
-- alert-evaluator function. Without this update the Systems Health page and
-- the seeded `alert_rules.description` still describe the old meaning.
--
-- What changed:
--   * executions_failing now counts DISTINCT failing signals (excluding
--     `order_close_audit` attempt rows) and additionally fires on a raw-row
--     storm at 3x max_failed. The old text described a plain row count.
--   * telegram_gap now measures active/trialing subscribers only (a trialing
--     row counts while trial_ends_at is in the future), falling back to all
--     linked sessions when subscriptions cannot be read.

UPDATE public.alert_rules
SET description = 'Distinct signals with failed executions in the window (order_close_audit attempt rows excluded), or a raw failure storm at 3x max_failed. Fires when either count passes the threshold.',
    updated_at = now()
WHERE code = 'executions_failing';

UPDATE public.alert_rules
SET description = 'Telegram sessions of paying subscribers (active, or trialing with an unexpired trial) that have no listener. Falls back to all linked sessions if subscriptions cannot be read.',
    updated_at = now()
WHERE code = 'telegram_gap';
