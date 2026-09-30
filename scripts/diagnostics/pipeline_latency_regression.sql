-- Pipeline latency regression (current window vs baseline).
-- Run in Supabase SQL Editor when trades feel slower than usual.
--
-- Edit windows here (defaults: last 6h vs prior 7 days excluding current window):
--   current:  created_at > now() - interval '6 hours'
--   baseline: created_at between now() - interval '7 days' and now() - interval '6 hours'

-- ---------------------------------------------------------------------------
-- 1) Stage percentiles: current vs baseline (live_fast entry path)
-- ---------------------------------------------------------------------------
with params as (
  select
    now() - interval '6 hours' as current_start,
    now() as current_end,
    now() - interval '7 days' as baseline_start,
    now() - interval '6 hours' as baseline_end
),
current_window as (
  select
    'current' as window_label,
    count(*) as samples,
    percentile_cont(0.50) within group (order by (request_payload->>'total_ms')::numeric) as p50_total_ms,
    percentile_cont(0.95) within group (order by (request_payload->>'total_ms')::numeric) as p95_total_ms,
    percentile_cont(0.99) within group (order by (request_payload->>'total_ms')::numeric) as p99_total_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'listener_to_dispatch_ms','')::numeric) as p50_listener_to_dispatch_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'parse_ms','')::numeric) as p50_parse_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'dispatch_ms','')::numeric) as p50_dispatch_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'prep_ms','')::numeric) as p50_prep_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'order_send_ms','')::numeric) as p50_order_send_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'broker_send_ms','')::numeric) as p50_broker_send_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'broker_resolve_ms','')::numeric) as p50_broker_resolve_ms,
    percentile_cont(0.95) within group (order by nullif(request_payload->>'dispatch_ms','')::numeric) as p95_dispatch_ms,
    percentile_cont(0.95) within group (order by nullif(request_payload->>'broker_resolve_ms','')::numeric) as p95_broker_resolve_ms,
    count(*) filter (where (request_payload->>'total_ms')::numeric > 4000) as slow_pipeline_count
  from trade_execution_logs, params
  where action = 'pipeline_summary'
    and created_at >= params.current_start
    and created_at < params.current_end
    and coalesce(request_payload->>'live_fast', 'false') = 'true'
    and (request_payload->>'total_ms') ~ '^\d+(\.\d+)?$'
),
baseline_window as (
  select
    'baseline_7d' as window_label,
    count(*) as samples,
    percentile_cont(0.50) within group (order by (request_payload->>'total_ms')::numeric) as p50_total_ms,
    percentile_cont(0.95) within group (order by (request_payload->>'total_ms')::numeric) as p95_total_ms,
    percentile_cont(0.99) within group (order by (request_payload->>'total_ms')::numeric) as p99_total_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'listener_to_dispatch_ms','')::numeric) as p50_listener_to_dispatch_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'parse_ms','')::numeric) as p50_parse_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'dispatch_ms','')::numeric) as p50_dispatch_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'prep_ms','')::numeric) as p50_prep_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'order_send_ms','')::numeric) as p50_order_send_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'broker_send_ms','')::numeric) as p50_broker_send_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'broker_resolve_ms','')::numeric) as p50_broker_resolve_ms,
    percentile_cont(0.95) within group (order by nullif(request_payload->>'dispatch_ms','')::numeric) as p95_dispatch_ms,
    percentile_cont(0.95) within group (order by nullif(request_payload->>'broker_resolve_ms','')::numeric) as p95_broker_resolve_ms,
    count(*) filter (where (request_payload->>'total_ms')::numeric > 4000) as slow_pipeline_count
  from trade_execution_logs, params
  where action = 'pipeline_summary'
    and created_at >= params.baseline_start
    and created_at < params.baseline_end
    and coalesce(request_payload->>'live_fast', 'false') = 'true'
    and (request_payload->>'total_ms') ~ '^\d+(\.\d+)?$'
)
select * from current_window
union all
select * from baseline_window;

-- ---------------------------------------------------------------------------
-- 2) % change current vs baseline (p50 total + key stages)
-- ---------------------------------------------------------------------------
with params as (
  select
    now() - interval '6 hours' as current_start,
    now() as current_end,
    now() - interval '7 days' as baseline_start,
    now() - interval '6 hours' as baseline_end
),
current_p50 as (
  select
    percentile_cont(0.50) within group (order by (request_payload->>'total_ms')::numeric) as total_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'dispatch_ms','')::numeric) as dispatch_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'broker_resolve_ms','')::numeric) as broker_resolve_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'broker_send_ms','')::numeric) as broker_send_ms
  from trade_execution_logs, params
  where action = 'pipeline_summary'
    and created_at >= params.current_start
    and created_at < params.current_end
    and coalesce(request_payload->>'live_fast', 'false') = 'true'
    and (request_payload->>'total_ms') ~ '^\d+(\.\d+)?$'
),
baseline_p50 as (
  select
    percentile_cont(0.50) within group (order by (request_payload->>'total_ms')::numeric) as total_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'dispatch_ms','')::numeric) as dispatch_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'broker_resolve_ms','')::numeric) as broker_resolve_ms,
    percentile_cont(0.50) within group (order by nullif(request_payload->>'broker_send_ms','')::numeric) as broker_send_ms
  from trade_execution_logs, params
  where action = 'pipeline_summary'
    and created_at >= params.baseline_start
    and created_at < params.baseline_end
    and coalesce(request_payload->>'live_fast', 'false') = 'true'
    and (request_payload->>'total_ms') ~ '^\d+(\.\d+)?$'
)
select
  round(100.0 * (c.total_ms - b.total_ms) / nullif(b.total_ms, 0), 1) as pct_change_p50_total_ms,
  round(100.0 * (c.dispatch_ms - b.dispatch_ms) / nullif(b.dispatch_ms, 0), 1) as pct_change_p50_dispatch_ms,
  round(100.0 * (c.broker_resolve_ms - b.broker_resolve_ms) / nullif(b.broker_resolve_ms, 0), 1) as pct_change_p50_broker_resolve_ms,
  round(100.0 * (c.broker_send_ms - b.broker_send_ms) / nullif(b.broker_send_ms, 0), 1) as pct_change_p50_broker_send_ms
from current_p50 c, baseline_p50 b;

-- ---------------------------------------------------------------------------
-- 3) dispatch_source breakdown (current 6h)
-- ---------------------------------------------------------------------------
select
  coalesce(request_payload->>'dispatch_source', 'unknown') as dispatch_source,
  count(*) as samples,
  percentile_cont(0.50) within group (order by (request_payload->>'total_ms')::numeric) as p50_total_ms,
  percentile_cont(0.95) within group (order by (request_payload->>'total_ms')::numeric) as p95_total_ms
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
  and (request_payload->>'total_ms') ~ '^\d+(\.\d+)?$'
group by 1
order by samples desc;

-- ---------------------------------------------------------------------------
-- 4) Warm vs cold broker session (current 6h)
-- ---------------------------------------------------------------------------
select
  coalesce((request_payload->>'brokers_warm_at_dispatch')::boolean, false) as brokers_warm,
  count(*) as samples,
  percentile_cont(0.50) within group (order by (request_payload->>'total_ms')::numeric) as p50_total_ms,
  percentile_cont(0.50) within group (order by nullif(request_payload->>'broker_resolve_ms','')::numeric) as p50_broker_resolve_ms
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
  and (request_payload->>'total_ms') ~ '^\d+(\.\d+)?$'
group by 1
order by 1 desc;

-- ---------------------------------------------------------------------------
-- 5) Worst users by p99 total_ms (current 6h, min 5 samples)
-- ---------------------------------------------------------------------------
select
  user_id,
  count(*) as samples,
  percentile_cont(0.50) within group (order by (request_payload->>'total_ms')::numeric) as p50_total_ms,
  percentile_cont(0.99) within group (order by (request_payload->>'total_ms')::numeric) as p99_total_ms,
  percentile_cont(0.95) within group (order by nullif(request_payload->>'dispatch_ms','')::numeric) as p95_dispatch_ms,
  percentile_cont(0.95) within group (order by nullif(request_payload->>'broker_resolve_ms','')::numeric) as p95_broker_resolve_ms
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
  and (request_payload->>'total_ms') ~ '^\d+(\.\d+)?$'
group by user_id
having count(*) >= 5
order by p99_total_ms desc nulls last
limit 20;

-- ---------------------------------------------------------------------------
-- 4) prep_ms substages (current window; requires worker with prep substage logging)
-- ---------------------------------------------------------------------------
select
  'prep_pre_handle_ms' as substage,
  count(*) filter (where (request_payload->>'prep_pre_handle_ms')::numeric > 0) as n,
  percentile_cont(0.50) within group (order by (request_payload->>'prep_pre_handle_ms')::numeric)
    filter (where (request_payload->>'prep_pre_handle_ms')::numeric > 0) as p50_ms,
  percentile_cont(0.95) within group (order by (request_payload->>'prep_pre_handle_ms')::numeric)
    filter (where (request_payload->>'prep_pre_handle_ms')::numeric > 0) as p95_ms
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
union all
select
  'prep_inflight_wait_ms',
  count(*) filter (where (request_payload->>'prep_inflight_wait_ms')::numeric > 0),
  percentile_cont(0.50) within group (order by (request_payload->>'prep_inflight_wait_ms')::numeric)
    filter (where (request_payload->>'prep_inflight_wait_ms')::numeric > 0),
  percentile_cont(0.95) within group (order by (request_payload->>'prep_inflight_wait_ms')::numeric)
    filter (where (request_payload->>'prep_inflight_wait_ms')::numeric > 0)
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
union all
select
  'prep_gates_ms',
  count(*) filter (where (request_payload->>'prep_gates_ms')::numeric > 0),
  percentile_cont(0.50) within group (order by (request_payload->>'prep_gates_ms')::numeric)
    filter (where (request_payload->>'prep_gates_ms')::numeric > 0),
  percentile_cont(0.95) within group (order by (request_payload->>'prep_gates_ms')::numeric)
    filter (where (request_payload->>'prep_gates_ms')::numeric > 0)
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
union all
select
  'prep_revision_db_ms',
  count(*) filter (where (request_payload->>'prep_revision_db_ms')::numeric > 0),
  percentile_cont(0.50) within group (order by (request_payload->>'prep_revision_db_ms')::numeric)
    filter (where (request_payload->>'prep_revision_db_ms')::numeric > 0),
  percentile_cont(0.95) within group (order by (request_payload->>'prep_revision_db_ms')::numeric)
    filter (where (request_payload->>'prep_revision_db_ms')::numeric > 0)
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
union all
select
  'prep_copy_limit_ms',
  count(*) filter (where (request_payload->>'prep_copy_limit_ms')::numeric > 0),
  percentile_cont(0.50) within group (order by (request_payload->>'prep_copy_limit_ms')::numeric)
    filter (where (request_payload->>'prep_copy_limit_ms')::numeric > 0),
  percentile_cont(0.95) within group (order by (request_payload->>'prep_copy_limit_ms')::numeric)
    filter (where (request_payload->>'prep_copy_limit_ms')::numeric > 0)
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
union all
select
  'prep_revision_flip_ms',
  count(*) filter (where (request_payload->>'prep_revision_flip_ms')::numeric > 0),
  percentile_cont(0.50) within group (order by (request_payload->>'prep_revision_flip_ms')::numeric)
    filter (where (request_payload->>'prep_revision_flip_ms')::numeric > 0),
  percentile_cont(0.95) within group (order by (request_payload->>'prep_revision_flip_ms')::numeric)
    filter (where (request_payload->>'prep_revision_flip_ms')::numeric > 0)
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
union all
select
  'prep_channel_meta_ms',
  count(*) filter (where (request_payload->>'prep_channel_meta_ms')::numeric > 0),
  percentile_cont(0.50) within group (order by (request_payload->>'prep_channel_meta_ms')::numeric)
    filter (where (request_payload->>'prep_channel_meta_ms')::numeric > 0),
  percentile_cont(0.95) within group (order by (request_payload->>'prep_channel_meta_ms')::numeric)
    filter (where (request_payload->>'prep_channel_meta_ms')::numeric > 0)
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '6 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
order by p95_ms desc nulls last;
