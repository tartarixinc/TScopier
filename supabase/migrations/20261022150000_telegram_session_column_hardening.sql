-- Lock the Telegram auth key to the backend.
--
-- telegram_sessions.session_string is a complete MTProto auth key. Anyone who
-- can read it can take over that user's Telegram account from another machine,
-- with no password and no code prompt.
--
-- The table-level SELECT granted to the API roles let every signed-in user
-- fetch their own key, and every admin fetch all keys, through PostgREST.
-- No application or admin screen needs the key itself: clients read `id` /
-- `user_id`, and the admin panel reads phone_number, is_active,
-- listener_engine and timestamps. Only the worker and server-side services
-- (service_role) need the key, so only they keep access to it.
--
-- The admin SELECT policy (created by tscopier-admin) stays in place; with
-- these column grants it can no longer expose session_string.
--
-- service_role is intentionally untouched.

revoke all on table public.telegram_sessions from anon;
-- Table-level SELECT must go first; the column grant below replaces it.
revoke select, insert, update, truncate, references, trigger
  on table public.telegram_sessions from authenticated;

-- Row access is still governed by RLS (own row, or admin via is_admin()).
-- DELETE stays: the app keeps it as the disconnect fallback.
grant select (id, user_id, phone_number, is_active, created_at, updated_at, listener_engine)
  on table public.telegram_sessions to authenticated;

notify pgrst, 'reload schema';
