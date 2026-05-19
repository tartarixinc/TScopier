-- Listener shard ownership: one active MTProto consumer per Telegram user session.

CREATE TABLE IF NOT EXISTS public.worker_session_leases (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  role text NOT NULL DEFAULT 'listener',
  shard_id int NOT NULL DEFAULT 0,
  shard_count int NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_worker_session_leases_expires
  ON public.worker_session_leases (expires_at);

COMMENT ON TABLE public.worker_session_leases IS
  'Which worker instance holds the live Telegram MTProto connection for each user.';

ALTER TABLE public.worker_session_leases ENABLE ROW LEVEL SECURITY;

-- Service role only (worker uses service key).
CREATE POLICY worker_session_leases_service ON public.worker_session_leases
  FOR ALL
  USING (false)
  WITH CHECK (false);
