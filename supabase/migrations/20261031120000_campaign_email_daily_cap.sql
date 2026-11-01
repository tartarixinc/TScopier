-- Cross-campaign daily cap: at most ONE campaign email per user per 24 hours.
--
-- Symptom (prod audit 2026-10-31): each recipient RPC throttles only itself —
-- no_subscription_nudge has a 3-day window, invoice_due a 3-day window,
-- trial_expired sends once ever — so a single hourly cron run could deliver all
-- three to the same user within seconds (51 user-hours in 14 days received 2+
-- different campaign emails in one hour; worst case 3 emails in 2 seconds).
-- The per-type windows are correct; what was missing is a shared daily limit.
--
-- The cap counts campaign rows only (no_subscription_nudge, trial_expired,
-- invoice_due, broadcast). Transactional mail (signal review, broker override,
-- billing) is deliberately excluded, and unsubscribe_recovery_email is
-- excluded so the escape-hatch email is never suppressed.
--
-- Guarded: environments without the campaign tables (staging has no
-- email_unsubscribes) skip cleanly so migrations:check stays green everywhere.
-- Registration at the end always runs so every database records the version.

DO $do$
BEGIN
  IF to_regclass('public.email_campaign_log') IS NULL
    OR to_regclass('public.email_unsubscribes') IS NULL
    OR to_regclass('public.subscriptions') IS NULL
    OR to_regclass('public.user_profiles') IS NULL
    OR to_regclass('auth.users') IS NULL
  THEN
    RAISE NOTICE 'campaign email objects absent — skipping (this environment does not run campaign emails)';
    RETURN;
  END IF;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.get_no_subscription_nudge_recipients()
 RETURNS TABLE(user_id uuid, email text, display_name text, first_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT
  up.user_id,
  au.email::text,
  up.display_name,
  up.first_name
FROM user_profiles up
JOIN auth.users au ON au.id = up.user_id
WHERE
  -- Onboarded at least 1 hour ago
  up.onboarding_completed_at IS NOT NULL
  AND up.onboarding_completed_at <= now() - interval '1 hour'
  -- No active or trialing subscription
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.user_id = up.user_id
    AND s.status IN ('active', 'trialing')
  )
  -- Not unsubscribed from emails
  AND NOT EXISTS (
    SELECT 1 FROM email_unsubscribes eu
    WHERE eu.user_id = up.user_id
  )
  -- Last nudge email was more than 3 days ago or never sent
  AND NOT EXISTS (
    SELECT 1 FROM email_campaign_log ecl
    WHERE ecl.user_id = up.user_id
    AND ecl.campaign_type = 'no_subscription_nudge'
    AND ecl.sent_at > now() - interval '3 days'
  )
  -- One campaign email per user per 24 hours (cross-campaign cap)
  AND NOT EXISTS (
    SELECT 1 FROM email_campaign_log ecl_day
    WHERE ecl_day.user_id = up.user_id
    AND ecl_day.campaign_type IN ('no_subscription_nudge','trial_expired','invoice_due','broadcast')
    AND ecl_day.sent_at > now() - interval '24 hours'
  )
LIMIT 50;
$function$;
  $fn$;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.get_trial_expired_recipients()
 RETURNS TABLE(user_id uuid, email text, display_name text, first_name text, stripe_customer_id text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT
  up.user_id,
  au.email::text,
  up.display_name,
  up.first_name,
  s.stripe_customer_id
FROM user_profiles up
JOIN auth.users au ON au.id = up.user_id
JOIN subscriptions s ON s.user_id = up.user_id
WHERE
  (
    s.status = 'canceled'
    OR (s.trial_ends_at IS NOT NULL AND s.trial_ends_at < now() AND s.status NOT IN ('active', 'trialing'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM email_unsubscribes eu
    WHERE eu.user_id = up.user_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM email_campaign_log ecl
    WHERE ecl.user_id = up.user_id
    AND ecl.campaign_type = 'trial_expired'
  )
  -- One campaign email per user per 24 hours (cross-campaign cap)
  AND NOT EXISTS (
    SELECT 1 FROM email_campaign_log ecl_day
    WHERE ecl_day.user_id = up.user_id
    AND ecl_day.campaign_type IN ('no_subscription_nudge','trial_expired','invoice_due','broadcast')
    AND ecl_day.sent_at > now() - interval '24 hours'
  )
LIMIT 50;
$function$;
  $fn$;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.get_invoice_due_recipients()
 RETURNS TABLE(user_id uuid, email text, display_name text, first_name text, stripe_customer_id text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT
  up.user_id,
  au.email::text,
  up.display_name,
  up.first_name,
  s.stripe_customer_id
FROM user_profiles up
JOIN auth.users au ON au.id = up.user_id
JOIN subscriptions s ON s.user_id = up.user_id
WHERE
  -- Subscription is past_due (payment failed)
  s.status = 'past_due'
  -- Must have a Stripe customer ID to look up the invoice
  AND s.stripe_customer_id IS NOT NULL
  -- Not unsubscribed from emails
  AND NOT EXISTS (
    SELECT 1 FROM email_unsubscribes eu
    WHERE eu.user_id = up.user_id
  )
  -- Last invoice_due email was more than 3 days ago or never sent
  AND NOT EXISTS (
    SELECT 1 FROM email_campaign_log ecl
    WHERE ecl.user_id = up.user_id
    AND ecl.campaign_type = 'invoice_due'
    AND ecl.sent_at > now() - interval '3 days'
  )
  -- One campaign email per user per 24 hours (cross-campaign cap)
  AND NOT EXISTS (
    SELECT 1 FROM email_campaign_log ecl_day
    WHERE ecl_day.user_id = up.user_id
    AND ecl_day.campaign_type IN ('no_subscription_nudge','trial_expired','invoice_due','broadcast')
    AND ecl_day.sent_at > now() - interval '24 hours'
  )
LIMIT 20;
$function$;
  $fn$;
END
$do$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261031120000', '20261031120000_campaign_email_daily_cap')
ON CONFLICT (version) DO NOTHING;
