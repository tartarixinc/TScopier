-- Raise default trade_execution_logs retention from 20 → 500 per user.
-- The worker passes TRADE_LOG_RETENTION_KEEP explicitly; this aligns the SQL default.

CREATE OR REPLACE FUNCTION public.prune_all_trade_execution_logs(
  p_keep integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_keep < 1 THEN
    p_keep := 500;
  END IF;

  WITH ranked AS (
    SELECT id,
      row_number() OVER (
        PARTITION BY user_id
        ORDER BY created_at DESC, id DESC
      ) AS rn
    FROM public.trade_execution_logs
  ),
  doomed AS (
    SELECT id FROM ranked WHERE rn > p_keep
  )
  DELETE FROM public.trade_execution_logs t
  USING doomed d
  WHERE t.id = d.id;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION public.prune_all_trade_execution_logs IS
  'Batch retention: keep newest p_keep trade_execution_logs rows per user (default 500). Run on a schedule (worker or pg_cron).';
