-- =============================================================================
-- Reconcile SL/TP on broker for the latest entry wave (urgent ops script)
--
-- Problem: trades.sl / trades.tp may be set in DB after a parameter-refresh
-- signal, but OrderModify never reached the terminal (common when legs fill
-- after the basket refresh, or rebalance only touched part of the basket).
--
-- This script:
--   1) DIAGNOSTIC — lists open legs missing a successful basket_leg_modify
--   2) FIX — upserts basket_reconcile_jobs + basket_reconcile_legs so the
--      worker BasketSlTpReconcileMonitor pushes SL/TP within ~15s
--
-- Run in Supabase SQL editor (service role). Review step 1 before step 2.
-- =============================================================================

-- Optional: pin a specific anchor entry signal instead of "latest buy/sell"
-- \set target_signal_id 'e1d158c2-9f1f-444b-994a-13a65a37807a'

-- -----------------------------------------------------------------------------
-- STEP 1 — DIAGNOSTIC: open legs with DB stops but no broker modify log
-- -----------------------------------------------------------------------------
WITH params AS (
  SELECT
    coalesce(
      nullif(trim(''), ''),
      (
        SELECT s.id::text
        FROM signals s
        WHERE lower(coalesce(s.parsed_data->>'action', '')) IN ('buy', 'sell')
          AND coalesce(s.parsed_data->>'sl', '') ~ '^[0-9]'
        ORDER BY s.created_at DESC
        LIMIT 1
      )
    ) AS target_signal_id,
    timestamptz '2026-06-17 11:08:00+00' AS since_ts
),
recent_open AS (
  SELECT
    t.id AS trade_id,
    t.signal_id,
    t.user_id,
    t.broker_account_id,
    t.telegram_channel_id AS channel_id,
    t.symbol,
    t.direction,
    t.metaapi_order_id,
    t.sl,
    t.tp,
    t.lot_size,
    t.entry_price,
    t.opened_at,
    ba.label AS broker_label,
    ba.platform,
    row_number() OVER (
      PARTITION BY t.broker_account_id, t.signal_id
      ORDER BY t.opened_at ASC, t.id
    ) - 1 AS leg_index
  FROM trades t
  JOIN broker_accounts ba ON ba.id = t.broker_account_id
  CROSS JOIN params p
  WHERE t.status = 'open'
    AND t.opened_at >= p.since_ts
    AND t.sl IS NOT NULL AND t.sl > 0
    AND t.tp IS NOT NULL AND t.tp > 0
    AND t.metaapi_order_id IS NOT NULL
    AND t.metaapi_order_id ~ '^[0-9]+$'
),
modified AS (
  SELECT DISTINCT (tel.request_payload->>'trade_id')::uuid AS trade_id
  FROM trade_execution_logs tel
  CROSS JOIN params p
  WHERE tel.created_at >= p.since_ts
    AND tel.action = 'basket_leg_modify'
    AND tel.status = 'success'
    AND tel.request_payload->>'trade_id' IS NOT NULL
)
SELECT
  ro.trade_id,
  ro.signal_id,
  ro.broker_label,
  ro.platform,
  ro.metaapi_order_id AS ticket,
  ro.sl,
  ro.tp,
  ro.leg_index,
  ro.opened_at,
  'NEEDS_BROKER_MODIFY' AS issue
FROM recent_open ro
LEFT JOIN modified m ON m.trade_id = ro.trade_id
WHERE m.trade_id IS NULL
ORDER BY ro.opened_at DESC;

-- -----------------------------------------------------------------------------
-- STEP 2 — ENQUEUE broker reconcile (safe to re-run; upserts jobs + legs)
-- -----------------------------------------------------------------------------
WITH params AS (
  SELECT timestamptz '2026-06-17 11:08:00+00' AS since_ts
),
recent_open AS (
  SELECT
    t.id AS trade_id,
    t.signal_id AS anchor_signal_id,
    t.user_id,
    t.broker_account_id,
    t.telegram_channel_id AS channel_id,
    t.symbol,
    t.direction,
    t.metaapi_order_id,
    t.sl,
    t.tp,
    t.opened_at,
    row_number() OVER (
      PARTITION BY t.broker_account_id, t.signal_id
      ORDER BY t.opened_at ASC, t.id
    ) - 1 AS leg_index
  FROM trades t
  CROSS JOIN params p
  WHERE t.status = 'open'
    AND t.opened_at >= p.since_ts
    AND t.sl IS NOT NULL AND t.sl > 0
    AND t.tp IS NOT NULL AND t.tp > 0
    AND t.metaapi_order_id IS NOT NULL
    AND t.metaapi_order_id ~ '^[0-9]+$'
),
modified AS (
  SELECT DISTINCT (tel.request_payload->>'trade_id')::uuid AS trade_id
  FROM trade_execution_logs tel
  CROSS JOIN params p
  WHERE tel.created_at >= p.since_ts
    AND tel.action = 'basket_leg_modify'
    AND tel.status = 'success'
    AND tel.request_payload->>'trade_id' IS NOT NULL
),
needs_reconcile AS (
  SELECT ro.*
  FROM recent_open ro
  LEFT JOIN modified m ON m.trade_id = ro.trade_id
  WHERE m.trade_id IS NULL
),
baskets AS (
  SELECT
    user_id,
    broker_account_id,
    anchor_signal_id,
    channel_id,
    min(symbol) AS symbol,
    min(direction) AS direction,
    jsonb_agg(
      jsonb_build_object(
        'stoploss', sl::double precision,
        'takeprofit', tp::double precision
      )
      ORDER BY leg_index
    ) AS per_leg_targets,
    max(tp)::double precision AS override_tp
  FROM needs_reconcile
  GROUP BY user_id, broker_account_id, anchor_signal_id, channel_id
),
upserted_jobs AS (
  INSERT INTO basket_reconcile_jobs (
    user_id,
    broker_account_id,
    anchor_signal_id,
    source_signal_id,
    channel_id,
    symbol,
    direction,
    per_leg_targets,
    virtual_pendings_snapshot,
    n_imm_cwe,
    override_tp,
    status,
    attempts,
    max_attempts,
    next_run_at,
    last_error,
    updated_at
  )
  SELECT
    b.user_id,
    b.broker_account_id,
    b.anchor_signal_id,
    b.anchor_signal_id,
    b.channel_id,
    b.symbol,
    b.direction,
    b.per_leg_targets,
    NULL,
    0,
    b.override_tp,
    'pending',
    0,
    48,
    now(),
    'manual_sql_reconcile_missing_broker_modify',
    now()
  FROM baskets b
  ON CONFLICT (broker_account_id, anchor_signal_id) DO UPDATE SET
    per_leg_targets = EXCLUDED.per_leg_targets,
    override_tp = EXCLUDED.override_tp,
    status = 'pending',
    attempts = 0,
    next_run_at = now(),
    last_error = EXCLUDED.last_error,
    locked_at = NULL,
    locked_by = NULL,
    updated_at = now()
  RETURNING id, broker_account_id, anchor_signal_id
)
INSERT INTO basket_reconcile_legs (
  trade_id,
  job_id,
  leg_index,
  ticket,
  desired_sl,
  desired_tp
)
SELECT
  nr.trade_id,
  j.id,
  nr.leg_index,
  nr.metaapi_order_id::bigint,
  nr.sl,
  nr.tp
FROM needs_reconcile nr
JOIN upserted_jobs j
  ON j.broker_account_id = nr.broker_account_id
 AND j.anchor_signal_id = nr.anchor_signal_id
ON CONFLICT (trade_id) DO UPDATE SET
  job_id = EXCLUDED.job_id,
  leg_index = EXCLUDED.leg_index,
  ticket = EXCLUDED.ticket,
  desired_sl = EXCLUDED.desired_sl,
  desired_tp = EXCLUDED.desired_tp;

-- -----------------------------------------------------------------------------
-- STEP 3 — VERIFY jobs queued
-- -----------------------------------------------------------------------------
SELECT
  j.id,
  j.status,
  j.next_run_at,
  j.attempts,
  ba.label AS broker,
  ba.platform,
  j.anchor_signal_id,
  j.symbol,
  j.direction,
  jsonb_array_length(j.per_leg_targets) AS leg_targets,
  j.last_error
FROM basket_reconcile_jobs j
JOIN broker_accounts ba ON ba.id = j.broker_account_id
WHERE j.last_error = 'manual_sql_reconcile_missing_broker_modify'
   OR j.updated_at >= now() - interval '5 minutes'
ORDER BY j.updated_at DESC;
