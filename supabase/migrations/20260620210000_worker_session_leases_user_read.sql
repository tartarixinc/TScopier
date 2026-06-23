-- Let authenticated users read their own listener lease (Copier Engine status badge).

CREATE POLICY worker_session_leases_user_read ON public.worker_session_leases
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

COMMENT ON POLICY worker_session_leases_user_read ON public.worker_session_leases IS
  'Users can see whether their copier listener lease is live (expires_at) on Copier Engine.';

-- Copier Engine badge updates when lease is renewed or expires.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'worker_session_leases'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.worker_session_leases';
  END IF;
END $$;
