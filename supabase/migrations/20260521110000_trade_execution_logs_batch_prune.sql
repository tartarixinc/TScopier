-- Replace per-insert prune trigger (2 queries per log row) with batch retention.

DROP TRIGGER IF EXISTS trade_execution_logs_prune ON public.trade_execution_logs;

CREATE OR REPLACE FUNCTION public.prune_all_trade_execution_logs(
  p_keep integer DEFAULT 20
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
    p_keep := 20;
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

REVOKE ALL ON FUNCTION public.prune_all_trade_execution_logs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_all_trade_execution_logs(integer) TO service_role;

COMMENT ON FUNCTION public.prune_all_trade_execution_logs IS
  'Batch retention: keep newest p_keep trade_execution_logs rows per user. Run on a schedule (worker or pg_cron).';
