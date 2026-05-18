-- Persist partial MTProto session after code step so 2FA can complete on another worker replica.

ALTER TABLE public.telegram_auth_pending
  ADD COLUMN IF NOT EXISTS awaiting_password boolean NOT NULL DEFAULT false;

ALTER TABLE public.telegram_auth_pending
  ADD COLUMN IF NOT EXISTS auth_session_string text;
