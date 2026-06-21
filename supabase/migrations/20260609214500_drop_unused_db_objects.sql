/*
  # Database cleanup — drop unused objects

  Audit (2026-06-09) cross-referenced every public table, view, function,
  trigger and cron job against the frontend (src/), worker (worker/src),
  edge functions (supabase/functions), backoffice (apps/), telegram-listener
  and scripts. Dropped objects below have zero references in application
  code, no database-internal callers, no attached triggers and no cron jobs.

  All 39 tables are referenced by live code — none are dropped.

  Dropped:
  - v_trade_channel_attribution_* views: one-off audit views from the June 2
    attribution-repair work; never queried by any app surface.
  - refresh_backtest_channel_signals + extract_channel_trade_signal_row +
    delete_backtest_channel_signals_outside_range: superseded by the
    upsert_backtest_channel_signal pipeline (worker/userListener.ts).
  - import_mt_servers: superseded by the sync-mt-servers edge function,
    which inserts into mt_servers directly.
  - trg_prune_trade_execution_logs + prune_trade_execution_logs: orphaned
    trigger function (not attached to any trigger) and its only callee;
    retention now runs via prune_all_trade_execution_logs
    (worker/src/tradeLogRetention.ts).
  - tmp_db_inventory: temporary introspection helper from this audit.
*/

-- Unused audit views (no app references)
drop view if exists public.v_trade_channel_attribution_quality_daily;
drop view if exists public.v_trade_channel_attribution_unlinked_details;

-- Superseded backtest signal extraction pipeline
drop function if exists public.refresh_backtest_channel_signals(
  p_user_id uuid, p_channel_ids uuid[], p_from timestamptz, p_to timestamptz);
drop function if exists public.extract_channel_trade_signal_row(p_signal public.signals);
drop function if exists public.delete_backtest_channel_signals_outside_range(
  p_user_id uuid, p_channel_ids uuid[], p_from timestamptz, p_to timestamptz, p_sources text[]);

-- Superseded by sync-mt-servers edge function
drop function if exists public.import_mt_servers(raw_text text, target_platform text);

-- Orphaned per-user log-prune trigger function (no trigger attached) and its callee
drop function if exists public.trg_prune_trade_execution_logs();
drop function if exists public.prune_trade_execution_logs(p_user_id uuid, p_keep integer);

-- Temporary introspection helper from this audit
drop function if exists public.tmp_db_inventory();
