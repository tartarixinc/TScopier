/*
  Ensure every auth signup (including OAuth/Google) has a user_profiles row.
*/

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
BEGIN
  IF full_name_val = '' THEN
    full_name_val := btrim(CONCAT(first_name_val, ' ', last_name_val));
  END IF;
  display_name_val := full_name_val;

  username_val := COALESCE(split_part(COALESCE(NEW.email, ''), '@', 1), '');

  INSERT INTO public.user_profiles (
    user_id,
    display_name,
    first_name,
    last_name,
    username
  )
  VALUES (
    NEW.id,
    display_name_val,
    first_name_val,
    last_name_val,
    username_val
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_create_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_create_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user_profile();

-- Backfill any already-existing auth users missing profiles.
INSERT INTO public.user_profiles (
  user_id,
  display_name,
  first_name,
  last_name,
  username
)
SELECT
  u.id,
  COALESCE(
    NULLIF(COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''), ''),
    btrim(CONCAT(
      COALESCE(u.raw_user_meta_data->>'first_name', ''),
      ' ',
      COALESCE(u.raw_user_meta_data->>'last_name', '')
    ))
  ) AS display_name,
  COALESCE(NULLIF(u.raw_user_meta_data->>'first_name', ''), '') AS first_name,
  COALESCE(NULLIF(u.raw_user_meta_data->>'last_name', ''), '') AS last_name,
  COALESCE(split_part(COALESCE(u.email, ''), '@', 1), '') AS username
FROM auth.users u
LEFT JOIN public.user_profiles p
  ON p.user_id = u.id
WHERE p.user_id IS NULL;

REVOKE ALL ON FUNCTION public.handle_new_auth_user_profile() FROM PUBLIC;
