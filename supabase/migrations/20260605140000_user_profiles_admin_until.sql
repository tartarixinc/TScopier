/*
  # Timed admin access on user_profiles

  - admin_until: when set, admin bypass (is_admin) is active only until this timestamp.
  - NULL admin_until + is_admin=true means permanent admin.
  - pg_cron sweeps expired rows and sets is_admin=false.
*/

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS admin_until timestamptz;

COMMENT ON COLUMN public.user_profiles.admin_until IS
  'When is_admin is true: NULL = permanent admin; future timestamp = timed admin; past = inactive until cron clears is_admin.';

CREATE INDEX IF NOT EXISTS idx_user_profiles_admin_until_expiry
  ON public.user_profiles (admin_until)
  WHERE is_admin = true AND admin_until IS NOT NULL;

CREATE OR REPLACE FUNCTION public.protect_user_profiles_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    OR current_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- Allow subscriptions sync trigger to mirror status only
  IF COALESCE(current_setting('app.allow_profile_subscription_sync', true), '') = 'true' THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.is_admin := OLD.is_admin;
      NEW.admin_until := OLD.admin_until;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.is_admin := false;
    NEW.admin_until := NULL;
    NEW.subscription_status := NULL;
  ELSE
    NEW.is_admin := OLD.is_admin;
    NEW.admin_until := OLD.admin_until;
    NEW.subscription_status := OLD.subscription_status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_timed_admin_access()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.user_profiles
  SET is_admin = false,
      updated_at = now()
  WHERE is_admin = true
    AND admin_until IS NOT NULL
    AND admin_until <= now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_timed_admin_access() FROM PUBLIC;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'expire-timed-admin-access';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'expire-timed-admin-access',
  '*/5 * * * *',
  $$SELECT public.expire_timed_admin_access();$$
);
