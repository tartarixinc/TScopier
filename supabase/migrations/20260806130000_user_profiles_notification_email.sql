ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS notification_email_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_profiles.notification_email_enabled IS
  'When true, send an email when a signal is escalated for human review (within the 2-minute approval window).';
