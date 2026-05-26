/*
  # One subscription row per user (required for webhook upsert onConflict user_id)
*/

DELETE FROM public.subscriptions a
USING public.subscriptions b
WHERE a.user_id = b.user_id
  AND a.created_at < b.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_id_unique
  ON public.subscriptions (user_id);
