-- Serialize FxSocket ConnectEx across Edge + Worker processes (same broker server).

CREATE TABLE IF NOT EXISTS public.mt_server_connect_locks (
  lock_key text PRIMARY KEY,
  holder text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS mt_server_connect_locks_expires_at_idx
  ON public.mt_server_connect_locks (expires_at);

CREATE OR REPLACE FUNCTION public.try_acquire_mt_server_connect_lock(
  p_lock_key text,
  p_holder text,
  p_ttl_seconds int DEFAULT 120
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_expires timestamptz := v_now + make_interval(secs => GREATEST(5, LEAST(p_ttl_seconds, 300)));
BEGIN
  DELETE FROM public.mt_server_connect_locks
  WHERE lock_key = p_lock_key AND expires_at <= v_now;

  INSERT INTO public.mt_server_connect_locks (lock_key, holder, expires_at)
  VALUES (p_lock_key, p_holder, v_expires)
  ON CONFLICT (lock_key) DO NOTHING;

  RETURN EXISTS (
    SELECT 1 FROM public.mt_server_connect_locks
    WHERE lock_key = p_lock_key AND holder = p_holder AND expires_at > v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_mt_server_connect_lock(
  p_lock_key text,
  p_holder text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.mt_server_connect_locks
  WHERE lock_key = p_lock_key AND holder = p_holder;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_mt_server_connect_lock(text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_mt_server_connect_lock(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_acquire_mt_server_connect_lock(text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_mt_server_connect_lock(text, text) TO service_role;
