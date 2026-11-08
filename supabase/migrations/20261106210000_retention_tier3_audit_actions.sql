-- Protect the audit trail in trade_execution_logs retention.
--
-- Plain English: the worker prunes `trade_execution_logs` down to the newest
-- 500 rows per user every 10 minutes. The existing three tiers protect
-- "displayable" actions (order_send, basket_leg_modify, dispatch_skipped,
-- auto_be, ...) as one class — but that class is itself floodable: on
-- 2026-11-06 a busy user kept 379 basket_leg_modify rows and only 11
-- order_send rows inside a 48-minute window, so the rows needed to
-- reconstruct an incident (what was sent to the broker, what management ran)
-- were pruned within hours. The Gold Pro "Close 20%" audit hit exactly this:
-- signal 415's order_send rows were gone by the time we looked.
--
-- This adds a fourth, highest tier for the small set of audit-critical
-- actions — broker sends, management commands, entry-pending lifecycle and
-- partial-TP fires. Tier-2 noise (basket/dispatch chatter) can no longer
-- displace them; they are only displaced by other tier-3 rows once a user
-- genuinely has more than p_keep of them.
--
-- Applies the same definition to both migration and production projects.

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
  -- Floor on the total rows kept per user (guards misconfigured callers).
  IF p_keep < 500 THEN
    p_keep := 500;
  END IF;

  WITH ranked AS (
    SELECT id,
      row_number() OVER (
        PARTITION BY user_id
        ORDER BY
          CASE
            -- Tier 3: audit-critical — what we sent to the broker and what
            -- management did. Needed to reconstruct any incident.
            WHEN action IN (
              'order_send',
              'order_send_adopted',
              'partial_tp_fired',
              'user_force_close',
              'opposite_signal_close'
            ) THEN 3
            WHEN action LIKE 'mgmt\_%' THEN 3
            WHEN action LIKE 'signal_entry_pending\_%' THEN 3
            WHEN action LIKE 'signal_range_entry\_%' THEN 3
            -- Tier 2: displayable trade/pipeline actions (user-visible).
            -- Retry-eligible set from src/lib/tradeActivities.ts
            -- RETRY_ELIGIBLE_ACTIONS, PIPELINE_ACTIONS, plus every other
            -- action that reaches the activity feed or the bell.
            -- (order_send, partial_tp_fired, user_force_close,
            -- opposite_signal_close, mgmt_*, signal_entry_pending_* and
            -- signal_range_entry_* are already matched by tier 3 above.)
            WHEN action IN (
              'merge_modify_summary',
              'cwe_close',
              'auto_be',
              'trailing_stop',
              'basket_leg_modify',
              'virtual_pending_fired',
              'virtual_pending_inserted',
              'virtual_pending_failed',
              'pipeline_parse_dispatch',
              'pipeline_parse',
              'dispatch_skipped',
              'keyword_parse',
              'plan_fallback',
              'range_basket_tp_rebalance',
              'dispatch_claim_error',
              'broker_manual_stop_override_reverted'
            ) THEN 2
            -- Tier 1: internal pipeline/queue diagnostics (previous
            -- priority set — kept, but after user-visible rows).
            WHEN action IN (
              'pipeline_summary',
              'dispatch_push_attempt',
              'parse_shadow_diff',
              'v2_reconcile_tick',
              'basket_reconcile_tick',
              'handle_start',
              'handle_end',
              'dispatch_received',
              'dispatch_route_decision',
              'dispatch_enqueue_attempt',
              'dispatch_enqueue_failed',
              'queue_consume_start',
              'queue_consume_ack',
              'queue_consume_retry',
              'queue_dead_letter',
              'merge_anchor_selected',
              'merge_routed_modify_only',
              'virtual_pending_tp_lock',
              -- Shadowed by the tier-3 `signal_entry_pending_%` LIKE above, so
              -- it can never rank as tier 1 today. Kept deliberately: if that
              -- pattern is ever narrowed, these info rows must not fall to 0.
              'signal_entry_pending_sync',
              'news_pre_close',
              'multi_range_plan',
              'stale_basket_reconciled'
            ) THEN 1
            ELSE 0
          END DESC,
          created_at DESC,
          id DESC
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
  'Batch retention: keep newest p_keep trade_execution_logs rows per user (default 500). Four tiers (DESC): tier 3 = audit-critical (order_send, mgmt_*, signal_entry_pending_*, signal_range_entry_*, partial_tp_fired) survives every flood; tier 2 = displayable activity rows; tier 1 = internal pipeline diagnostics; tier 0 = everything else, pruned first.';