/*
  Track explicit email verification for email/password signups.
  OAuth users are marked verified on signup; email users only on confirmation (UPDATE trigger).
*/

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

COMMENT ON COLUMN public.user_profiles.email_verified_at IS
  'When the user completed email verification. OAuth signups are set on insert; email/password on confirmation.';

CREATE OR REPLACE FUNCTION public.auth_user_is_oauth(u auth.users)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(u.raw_app_meta_data->'providers', '[]'::jsonb)) AS p(provider)
    WHERE provider <> 'email'
  );
$$;

-- Existing confirmed users keep access.
UPDATE public.user_profiles p
SET email_verified_at = u.email_confirmed_at
FROM auth.users u
WHERE u.id = p.user_id
  AND p.email_verified_at IS NULL
  AND u.email_confirmed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.handle_new_auth_user_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raw_meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  first_name_val text := COALESCE(NULLIF(raw_meta->>'first_name', ''), '');
  last_name_val text := COALESCE(NULLIF(raw_meta->>'last_name', ''), '');
  full_name_val text := COALESCE(
    NULLIF(raw_meta->>'full_name', ''),
    NULLIF(raw_meta->>'name', ''),
    ''
  );
  display_name_val text := '';
  username_val text := '';
  verified_at timestamptz := NULL;
BEGIN
  IF full_name_val = '' THEN
    full_name_val := btrim(CONCAT(first_name_val, ' ', last_name_val));
  END IF;
  display_name_val := full_name_val;
  username_val := COALESCE(split_part(COALESCE(NEW.email, ''), '@', 1), '');

  IF public.auth_user_is_oauth(NEW) AND NEW.email_confirmed_at IS NOT NULL THEN
    verified_at := NEW.email_confirmed_at;
  END IF;

  INSERT INTO public.user_profiles (
    user_id,
    display_name,
    first_name,
    last_name,
    username,
    email_verified_at
  )
  VALUES (
    NEW.id,
    display_name_val,
    first_name_val,
    last_name_val,
    username_val,
    verified_at
  )
  ON CONFLICT (user_id) DO UPDATE
  SET email_verified_at = COALESCE(public.user_profiles.email_verified_at, EXCLUDED.email_verified_at);

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_email_verified_on_confirm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.email_confirmed_at IS NULL
    AND NEW.email_confirmed_at IS NOT NULL
    AND NOT public.auth_user_is_oauth(NEW) THEN
    UPDATE public.user_profiles
    SET email_verified_at = NEW.email_confirmed_at,
        updated_at = now()
    WHERE user_id = NEW.id
      AND email_verified_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_email_verified_on_confirm();

CREATE OR REPLACE FUNCTION public.mark_email_verified()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  confirmed_at timestamptz;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT email_confirmed_at INTO confirmed_at
  FROM auth.users
  WHERE id = uid;

  IF confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Email not confirmed';
  END IF;

  UPDATE public.user_profiles
  SET email_verified_at = confirmed_at,
      updated_at = now()
  WHERE user_id = uid
    AND email_verified_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_email_verified() TO authenticated;

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

  IF COALESCE(current_setting('app.allow_profile_subscription_sync', true), '') = 'true' THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.is_admin := OLD.is_admin;
      NEW.admin_until := OLD.admin_until;
      NEW.email_verified_at := OLD.email_verified_at;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.is_admin := false;
    NEW.admin_until := NULL;
    NEW.subscription_status := NULL;
    NEW.email_verified_at := NULL;
  ELSE
    NEW.is_admin := OLD.is_admin;
    NEW.admin_until := OLD.admin_until;
    NEW.subscription_status := OLD.subscription_status;
    NEW.email_verified_at := OLD.email_verified_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_user_is_oauth(auth.users) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_email_verified_on_confirm() FROM PUBLIC;
