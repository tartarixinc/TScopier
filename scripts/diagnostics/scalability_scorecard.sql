-- Scalability scorecard (Supabase SQL Editor)
-- Purpose: identify the real bottleneck users/brokers/stages under load.
--
-- Usage:
-- 1) Run each block independently (same lookback window by default).
-- 2) Start with #1 and #2 (who is heavy, who is slow), then drill down.
-- 3) Prefer medians/p95/p99 over averages for copy-trading latency.

-- Common window (edit once, reuse mentally across queries):
-- last 24h for volume/error shape; last 1-6h for active incident analysis.

-- ---------------------------------------------------------------------------
-- 1) Top noisy users by execution activity (load footprint)
-- ---------------------------------------------------------------------------
select
  user_id,
  count(*) as log_rows,
  count(*) filter (where action = 'order_send') as order_send_rows,
  count(*) filter (where action = 'basket_leg_modify') as basket_modify_rows,
  count(*) filter (where action = 'partial_tp_fired') as partial_tp_rows,
  count(distinct signal_id) filter (where signal_id is not null) as distinct_signals
from trade_execution_logs
where created_at > now() - interval '24 hours'
group by user_id
order by log_rows desc
limit 50;

-- ---------------------------------------------------------------------------
-- 2) Worst users by end-to-end latency (pipeline_summary p50/p95/p99)
-- ---------------------------------------------------------------------------
select
  user_id,
  count(*) as samples,
  percentile_cont(0.50) within group (order by (request_payload->>'total_ms')::numeric) as p50_total_ms,
  percentile_cont(0.95) within group (order by (request_payload->>'total_ms')::numeric) as p95_total_ms,
  percentile_cont(0.99) within group (order by (request_payload->>'total_ms')::numeric) as p99_total_ms
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '24 hours'
  and (request_payload->>'total_ms') ~ '^\d+(\.\d+)?$'
group by user_id
having count(*) >= 5
order by p99_total_ms desc nulls last
limit 50;

-- ---------------------------------------------------------------------------
-- 3) Stage-level p95 by user (find where latency is spent)
-- ---------------------------------------------------------------------------
select
  user_id,
  count(*) as samples,
  percentile_cont(0.95) within group (order by nullif(request_payload->>'parse_ms','')::numeric) as p95_parse_ms,
  percentile_cont(0.95) within group (order by nullif(request_payload->>'dispatch_ms','')::numeric) as p95_dispatch_ms,
  percentile_cont(0.95) within group (order by nullif(request_payload->>'prep_ms','')::numeric) as p95_prep_ms,
  percentile_cont(0.95) within group (order by nullif(request_payload->>'order_send_ms','')::numeric) as p95_order_send_ms,
  percentile_cont(0.95) within group (order by nullif(request_payload->>'broker_send_ms','')::numeric) as p95_broker_send_ms
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '24 hours'
group by user_id
having count(*) >= 5
order by p95_order_send_ms desc nulls last
limit 50;

-- ---------------------------------------------------------------------------
-- 4) Broker hotspots (error-prone accounts)
-- ---------------------------------------------------------------------------
select
  broker_account_id,
  count(*) as total_actions,
  count(*) filter (where status = 'failed') as failed_actions,
  count(*) filter (where status = 'skipped') as skipped_actions,
  round(
    100.0 * count(*) filter (where status = 'failed') / nullif(count(*), 0),
    2
  ) as failed_pct
from trade_execution_logs
where created_at > now() - interval '24 hours'
  and broker_account_id is not null
  and action in ('order_send', 'basket_leg_modify', 'mgmt_modify', 'mgmt_close')
group by broker_account_id
having count(*) >= 20
order by failed_pct desc nulls last, failed_actions desc
limit 50;

-- ---------------------------------------------------------------------------
-- 5) Most common failure signatures (action + error text)
-- ---------------------------------------------------------------------------
select
  action,
  coalesce(nullif(error_message, ''), 'no_error_message') as error_message,
  count(*) as failures
from trade_execution_logs
where created_at > now() - interval '24 hours'
  and status = 'failed'
group by 1, 2
order by failures desc
limit 100;

-- ---------------------------------------------------------------------------
-- 6) Parsed signals that look stuck (never finalized)
-- ---------------------------------------------------------------------------
select
  s.user_id,
  s.id as signal_id,
  s.created_at,
  s.status,
  s.skip_reason,
  s.channel_id,
  left(s.raw_message, 120) as preview
from signals s
where s.status = 'parsed'
  and s.created_at < now() - interval '2 minutes'
  and s.created_at > now() - interval '24 hours'
order by s.created_at asc
limit 200;

-- ---------------------------------------------------------------------------
-- 7) Retry-storm detector (same signal repeatedly handled)
-- ---------------------------------------------------------------------------
select
  signal_id,
  user_id,
  count(*) filter (where action = 'handle_start') as handle_starts,
  count(*) filter (where action = 'handle_end') as handle_ends,
  min(created_at) as first_seen,
  max(created_at) as last_seen
from trade_execution_logs
where created_at > now() - interval '24 hours'
  and action in ('handle_start', 'handle_end')
group by signal_id, user_id
having count(*) filter (where action = 'handle_start') >= 3
order by handle_starts desc, last_seen desc
limit 200;

-- ---------------------------------------------------------------------------
-- 8) Dispatch path quality (live dispatch vs sweep fallback)
-- ---------------------------------------------------------------------------
select
  date_trunc('hour', created_at) as hour,
  count(*) as handle_start_rows,
  count(*) filter (where coalesce((request_payload->>'live_dispatch')::boolean, false) = true) as live_dispatch_rows,
  count(*) filter (where coalesce((request_payload->>'live_dispatch')::boolean, false) = false) as sweep_or_non_live_rows
from trade_execution_logs
where action = 'handle_start'
  and created_at > now() - interval '24 hours'
group by 1
order by 1 desc;

-- ---------------------------------------------------------------------------
-- 9) Signal fan-out pressure (orders/modifies per signal)
-- ---------------------------------------------------------------------------
select
  signal_id,
  user_id,
  count(*) filter (where action = 'order_send') as order_sends,
  count(*) filter (where action = 'basket_leg_modify') as basket_modifies,
  count(*) filter (where action like 'mgmt_%') as mgmt_actions,
  count(*) as total_log_rows
from trade_execution_logs
where created_at > now() - interval '24 hours'
group by signal_id, user_id
having count(*) >= 20
order by total_log_rows desc
limit 100;

-- ---------------------------------------------------------------------------
-- 10) Queue enqueue success vs failure (listener → Redis Streams)
-- ---------------------------------------------------------------------------
select
  date_trunc('hour', created_at) as hour,
  count(*) filter (where action = 'dispatch_enqueue_attempt') as enqueue_ok,
  count(*) filter (where action = 'dispatch_enqueue_failed') as enqueue_failed,
  percentile_cont(0.95) within group (
    order by (request_payload->>'enqueue_ms')::numeric
  ) filter (where action = 'dispatch_enqueue_attempt') as p95_enqueue_ms
from trade_execution_logs
where action in ('dispatch_enqueue_attempt', 'dispatch_enqueue_failed')
  and created_at > now() - interval '24 hours'
group by 1
order by 1 desc;

-- ---------------------------------------------------------------------------
-- 11) Queue consume latency (enqueue → consume start)
-- ---------------------------------------------------------------------------
select
  user_id,
  count(*) as samples,
  percentile_cont(0.50) within group (
    order by (request_payload->>'enqueue_to_start_ms')::numeric
  ) as p50_enqueue_to_start_ms,
  percentile_cont(0.95) within group (
    order by (request_payload->>'enqueue_to_start_ms')::numeric
  ) as p95_enqueue_to_start_ms,
  percentile_cont(0.99) within group (
    order by (request_payload->>'enqueue_to_start_ms')::numeric
  ) as p99_enqueue_to_start_ms
from trade_execution_logs
where action = 'queue_consume_start'
  and created_at > now() - interval '24 hours'
  and (request_payload->>'enqueue_to_start_ms') ~ '^\d+(\.\d+)?$'
group by user_id
having count(*) >= 5
order by p99_enqueue_to_start_ms desc nulls last
limit 50;

-- ---------------------------------------------------------------------------
-- 12) Queue redelivery / retry pressure
-- ---------------------------------------------------------------------------
select
  signal_id,
  user_id,
  count(*) filter (where action = 'queue_consume_retry') as retries,
  count(*) filter (where action = 'queue_duplicate_skip') as duplicate_skips,
  count(*) filter (where action = 'queue_dead_letter') as dead_letters,
  max(created_at) as last_seen
from trade_execution_logs
where action in ('queue_consume_retry', 'queue_duplicate_skip', 'queue_dead_letter')
  and created_at > now() - interval '24 hours'
group by signal_id, user_id
having count(*) filter (where action = 'queue_consume_retry') >= 2
order by retries desc, last_seen desc
limit 100;

-- ---------------------------------------------------------------------------
-- 13) Dispatch path mix (queue vs HTTP push fallback)
-- ---------------------------------------------------------------------------
select
  date_trunc('hour', created_at) as hour,
  count(*) filter (where coalesce((request_payload->>'queue_enqueued')::boolean, false) = true) as queue_primary,
  count(*) filter (where coalesce((request_payload->>'http_push_fallback')::boolean, false) = true) as http_push_fallback,
  count(*) as route_decisions
from trade_execution_logs
where action = 'dispatch_route_decision'
  and created_at > now() - interval '24 hours'
group by 1
order by 1 desc;

-- ---------------------------------------------------------------------------
-- 14) Dead-letter queue growth (requires signal_queue_dead_letters migration)
-- ---------------------------------------------------------------------------
select
  lane,
  shard_id,
  count(*) filter (where status = 'dead') as open_dlq,
  count(*) filter (where status = 'replayed') as replayed,
  max(created_at) filter (where status = 'dead') as latest_dead_at
from signal_queue_dead_letters
where created_at > now() - interval '7 days'
group by lane, shard_id
order by open_dlq desc;

-- Alert thresholds (manual / external monitor):
-- - p99 enqueue_to_start_ms > 5000 on any shard
-- - dispatch_enqueue_failed rate > 1% of enqueue attempts for 15m
-- - queue_dead_letter count increasing > 10/hour
-- - http_push_fallback > 5% when TRADE_SIGNAL_QUEUE_ENABLED=true (queue unhealthy)

