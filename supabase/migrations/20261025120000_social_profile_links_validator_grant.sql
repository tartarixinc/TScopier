-- The profile-links validator is used by authenticated profile operations.
-- Keep this permission explicit and reproducible.
GRANT EXECUTE
ON FUNCTION public.social_profile_links_are_valid(jsonb)
TO authenticated;
