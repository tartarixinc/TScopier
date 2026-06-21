ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS user_override jsonb;

COMMENT ON COLUMN public.signals.user_override IS
  'User SL/TP/entry overrides from Manage Signals; merged over parsed_data.';
