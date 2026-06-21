/*
  One Telegram account (phone / Telegram user id) may only be linked to one TScopier user.
  Rows persist after disconnect so users cannot reuse the same Telegram on a new account.
*/

CREATE TABLE IF NOT EXISTS public.telegram_account_claims (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_user_id bigint UNIQUE,
  phone_number_normalized text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_account_claims_phone
  ON public.telegram_account_claims (phone_number_normalized);

COMMENT ON TABLE public.telegram_account_claims IS
  'Permanent Telegram identity binding. Survives telegram_sessions disconnect.';

ALTER TABLE public.telegram_account_claims ENABLE ROW LEVEL SECURITY;

-- Worker uses service role; clients never read/write claims directly.
REVOKE ALL ON public.telegram_account_claims FROM anon, authenticated;

-- Backfill from active sessions (earliest link wins when duplicates exist).
INSERT INTO public.telegram_account_claims (user_id, phone_number_normalized, linked_at)
SELECT user_id, normalized, created_at
FROM (
  SELECT DISTINCT ON (normalized)
    user_id,
    created_at,
    CASE
      WHEN regexp_replace(trim(phone_number), '[\s\-()]', '', 'g') ~ '^00'
        THEN '+' || substring(regexp_replace(trim(phone_number), '[\s\-()]', '', 'g') FROM 3)
      ELSE regexp_replace(trim(phone_number), '[\s\-()]', '', 'g')
    END AS normalized
  FROM public.telegram_sessions
  WHERE trim(phone_number) <> ''
  ORDER BY normalized, created_at ASC
) s
WHERE normalized <> ''
ON CONFLICT (phone_number_normalized) DO NOTHING;
