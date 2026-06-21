ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS copier_paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_profiles.copier_paused IS
  'When true, worker stops all signal copying and trade executions for this user.';
