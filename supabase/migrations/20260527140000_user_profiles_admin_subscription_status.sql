/*
  # Admin flag + subscription status mirror on user_profiles

  - is_admin: bypass paywall when true (set only via service role / SQL)
  - subscription_status: denormalized copy of subscriptions.status for quick reads
*/

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS subscription_status text;

COMMENT ON COLUMN public.user_profiles.is_admin IS
  'When true, user bypasses subscription paywall. Only service role may change this column.';

COMMENT ON COLUMN public.user_profiles.subscription_status IS
  'Mirror of subscriptions.status; synced by trigger. Read-only for authenticated users.';

-- Backfill from subscriptions
UPDATE public.user_profiles p
SET subscription_status = s.status
FROM public.subscriptions s
WHERE s.user_id = p.user_id
  AND (p.subscription_status IS DISTINCT FROM s.status);

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
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.is_admin := false;
    NEW.subscription_status := NULL;
  ELSE
    NEW.is_admin := OLD.is_admin;
    NEW.subscription_status := OLD.subscription_status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_profiles_protect_privileged ON public.user_profiles;
CREATE TRIGGER user_profiles_protect_privileged
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_user_profiles_privileged_columns();

CREATE OR REPLACE FUNCTION public.sync_user_profile_subscription_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.allow_profile_subscription_sync', 'true', true);

  IF TG_OP = 'DELETE' THEN
    UPDATE public.user_profiles
    SET subscription_status = NULL
    WHERE user_id = OLD.user_id;
    RETURN OLD;
  END IF;

  UPDATE public.user_profiles
  SET subscription_status = NEW.status
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_sync_profile_status ON public.subscriptions;
CREATE TRIGGER subscriptions_sync_profile_status
  AFTER INSERT OR UPDATE OF status OR DELETE ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_user_profile_subscription_status();

REVOKE ALL ON FUNCTION public.protect_user_profiles_privileged_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_user_profile_subscription_status() FROM PUBLIC;
