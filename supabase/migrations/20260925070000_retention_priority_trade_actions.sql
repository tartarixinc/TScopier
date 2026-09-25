-- Protect user-facing trade actions in trade_execution_logs retention.
--
-- Plain English: the activity/notifications feed reads the newest 500
-- trade_execution_logs rows per user. The prune function already ranked some
-- internal actions as "priority", but the actions users actually see
-- (order_send, partial_tp_fired, mgmt_* stops/tp changes, ...) were NOT in
-- that list. When a flood of priority rows (e.g. basket_reconcile_tick
-- failures) grew, the non-priority slots shrank and real trade rows were
-- evicted first — the Notifications panel then showed "No recent trade
-- activity yet". This migration uses three tiers so noise floods can no
-- longer squeeze user-visible rows out of the window:
--   2 = displayable trade/pipeline actions (user-visible, protected first)
--   1 = internal pipeline/queue diagnostics (previous priority set)
--   0 = everything else (pruned first)
-- A tier-2 flood can only push out internal diagnostics; internal floods can
-- no longer push out user-visible rows at all.
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
            -- Tier 2: displayable trade/pipeline actions (user-visible).
            -- Retry-eligible set from src/lib/tradeActivities.ts
            -- RETRY_ELIGIBLE_ACTIONS, PIPELINE_ACTIONS, plus every other
            -- action that reaches the activity feed or the bell.
            WHEN action IN (
              'order_send',
              'partial_tp_fired',
              'merge_modify_summary',
              'cwe_close',
              'auto_be',
              'trailing_stop',
              'opposite_signal_close',
              'basket_leg_modify',
              'virtual_pending_fired',
              'virtual_pending_inserted',
              'virtual_pending_failed',
              'signal_entry_pending_filled',
              'signal_entry_pending_placed',
              'signal_entry_pending_failed',
              'signal_entry_pending_cancelled',
              'signal_range_entry_waiting',
              'signal_range_entry_no_price',
              'signal_range_entry_fired',
              'signal_range_entry_expired',
              'signal_range_entry_tp_before_entry',
              'signal_range_entry_sl_before_entry',
              'signal_range_entry_updated',
              'signal_range_entry_cancelled',
              'signal_range_entry_wake_retry',
              'pipeline_parse_dispatch',
              'pipeline_parse',
              'dispatch_skipped',
              'keyword_parse',
              'plan_fallback',
              'range_basket_tp_rebalance',
              'user_force_close',
              'dispatch_claim_error',
              'broker_manual_stop_override_reverted'
            ) THEN 2
            -- All current and future management actions are user-visible.
            WHEN action LIKE 'mgmt\_%' THEN 2
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
  'Batch retention: keep newest p_keep trade_execution_logs rows per user (default 500). Three tiers (DESC): displayable trade/pipeline actions and mgmt_* rank highest so failure floods cannot evict user-visible activity rows; internal pipeline/queue diagnostics rank next; everything else is pruned first.';
