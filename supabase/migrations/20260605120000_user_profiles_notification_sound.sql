ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS notification_sound_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_profiles.notification_sound_enabled IS
  'When true, play a sound for new successful trade activity notifications in the app header.';
