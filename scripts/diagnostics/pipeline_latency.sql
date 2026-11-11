-- Pipeline latency percentiles (P50/P99) for copy speed monitoring.
-- Run in Supabase SQL Editor after deploy; use for shard health and alerting.
-- Load-test note: run this only against an isolated, allowlisted staging/test
-- Supabase project. Do not paste or run diagnostics against production as part
-- of synthetic load validation.

select
  date_trunc('minute', created_at) as minute,
  count(*) as samples,
  percentile_cont(0.5) within group (order by (request_payload->>'total_ms')::int) as p50_total_ms,
  percentile_cont(0.99) within group (order by (request_payload->>'total_ms')::int) as p99_total_ms,
  percentile_cont(0.5) within group (order by (request_payload->>'dispatch_ms')::int) as p50_dispatch_ms,
  percentile_cont(0.99) within group (order by (request_payload->>'order_send_ms')::int) as p99_order_send_ms
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '1 hour'
  and (request_payload->>'total_ms') ~ '^\d+$'
group by 1
order by 1 desc
limit 60;

-- dispatch_push_attempt failure rate (listener → trade worker HTTP push)
select
  date_trunc('hour', created_at) as hour,
  count(*) filter (where status = 'failed') as push_failed,
  count(*) filter (where status = 'success') as push_success,
  round(
    100.0 * count(*) filter (where status = 'failed')
    / nullif(count(*), 0),
    2
  ) as push_failure_pct
from trade_execution_logs
where action = 'dispatch_push_attempt'
  and created_at > now() - interval '24 hours'
group by 1
order by 1 desc;

-- broker_resolve_ms vs broker_send_ms (cold session vs send path)
select
  date_trunc('hour', created_at) as hour,
  count(*) as samples,
  percentile_cont(0.5) within group (order by (request_payload->>'broker_resolve_ms')::int) as p50_broker_resolve_ms,
  percentile_cont(0.99) within group (order by (request_payload->>'broker_resolve_ms')::int) as p99_broker_resolve_ms,
  percentile_cont(0.5) within group (order by (request_payload->>'broker_send_ms')::int) as p50_broker_send_ms,
  percentile_cont(0.99) within group (order by (request_payload->>'broker_send_ms')::int) as p99_broker_send_ms,
  count(*) filter (where (request_payload->>'brokers_warm_at_dispatch')::boolean is true) as warm_dispatch,
  count(*) filter (where (request_payload->>'brokers_warm_at_dispatch')::boolean is false) as cold_dispatch
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '24 hours'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
group by 1
order by 1 desc;

-- send_plan_ms + gateway/http attribution (entry-critical read lane fix)
-- After deploy, quote_gateway_wait_ms / opened_orders_gateway_wait_ms should drop;
-- target: warm live-fast p50 send_plan_ms < 1000 and pct total_ms >= 13000 falling.
select
  count(*) as samples,
  round(100.0 * count(*) filter (where (request_payload->>'total_ms')::int >= 13000) / nullif(count(*), 0), 1) as pct_ge_13s,
  percentile_cont(0.5) within group (order by (request_payload->>'total_ms')::int) as p50_total_ms,
  percentile_cont(0.9) within group (order by (request_payload->>'total_ms')::int) as p90_total_ms,
  percentile_cont(0.5) within group (order by (request_payload->>'send_plan_ms')::int) as p50_send_plan_ms,
  percentile_cont(0.9) within group (order by (request_payload->>'send_plan_ms')::int) as p90_send_plan_ms,
  percentile_cont(0.5) within group (order by (request_payload->>'broker_send_ms')::int) as p50_broker_send_ms,
  round(avg((request_payload->>'quote_gateway_wait_ms')::int)) as avg_quote_gateway_wait_ms,
  round(avg((request_payload->>'quote_http_ms')::int)) as avg_quote_http_ms,
  round(avg((request_payload->>'opened_orders_gateway_wait_ms')::int)) as avg_opened_orders_gateway_wait_ms,
  round(avg((request_payload->>'opened_orders_http_ms')::int)) as avg_opened_orders_http_ms,
  round(avg((request_payload->>'telegram_to_listener_ms')::int)) as avg_tg_to_listener_ms
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '24 hours'
  and (request_payload->>'total_ms') ~ '^\d+$'
  and coalesce(request_payload->>'live_fast', 'false') = 'true'
  and coalesce(request_payload->>'mgmt_fast_path', 'false') = 'false';

-- dispatch_source breakdown (listener_push vs sweep vs queue)
select
  date_trunc('hour', created_at) as hour,
  coalesce(request_payload->>'dispatch_source', 'unknown') as dispatch_source,
  count(*) as samples,
  percentile_cont(0.5) within group (order by (request_payload->>'total_ms')::int) as p50_total_ms,
  percentile_cont(0.99) within group (order by (request_payload->>'total_ms')::int) as p99_total_ms
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '24 hours'
group by 1, 2
order by 1 desc, 3 desc;

-- dispatch_skipped rate (misconfig / lease gate) — alert if rising
select
  date_trunc('hour', created_at) as hour,
  error_message as skip_reason,
  count(*) as skips
from trade_execution_logs
where action = 'dispatch_skipped'
  and created_at > now() - interval '24 hours'
group by 1, 2
order by 1 desc, 3 desc;

-- Management signal latency (CWE / modify): queue wait vs handle vs leg count
select
  date_trunc('hour', tel.created_at) as hour,
  s.parsed_data->>'action' as mgmt_action,
  count(*) as samples,
  percentile_cont(0.5) within group (order by (tel.request_payload->>'queue_wait_ms')::int) as p50_queue_wait_ms,
  percentile_cont(0.5) within group (order by (tel.request_payload->>'handle_ms')::int) as p50_handle_ms,
  percentile_cont(0.5) within group (order by (tel.request_payload->>'mgmt_wall_ms')::int) as p50_mgmt_wall_ms,
  percentile_cont(0.5) within group (order by (tel.request_payload->>'mgmt_legs_total')::int) as p50_mgmt_legs,
  percentile_cont(0.99) within group (order by (tel.request_payload->>'mgmt_wall_ms')::int) as p99_mgmt_wall_ms
from trade_execution_logs tel
join signals s on s.id = tel.signal_id
where tel.action in ('pipeline_summary', 'handle_end')
  and tel.created_at > now() - interval '24 hours'
  and coalesce(tel.request_payload->>'mgmt_fast_path', 'false') = 'true'
  and s.parsed_data->>'action' in ('close_worse_entries', 'modify', 'close', 'breakeven')
group by 1, 2
order by 1 desc, 2;

-- =============================================================================
-- Sub-3s SLO gate (Migration / staging) — run after Phase 0–2 deploy
-- Target: telegram_receipt_to_broker_request_ms p95 < 3000; dispatch_source != sweep
-- =============================================================================

-- Dispatch source mix (fresh signals must not be sweep/realtime)
select
  request_payload->>'dispatch_source' as source,
  count(*) as n
from trade_execution_logs
where action = 'pipeline_summary'
  and created_at > now() - interval '24 hours'
group by 1
order by 2 desc;

-- Fresh sweep alerts (live handoff missed)
select count(*) as fresh_sweep_alerts
from trade_execution_logs
where action = 'dispatch_sweep_fresh_alert'
  and created_at > now() - interval '24 hours';

-- Push 401/403/404 in last 24h (must be zero)
select
  count(*) filter (where (request_payload->>'status_code') in ('401','403','404')) as auth_route_fails,
  count(*) filter (where request_payload->>'ok' = 'true') as push_ok,
  count(*) as push_attempts
from trade_execution_logs
where action = 'dispatch_push_attempt'
  and request_payload->>'phase' = 'attempt'
  and created_at > now() - interval '24 hours';

-- End-to-end from durable pipeline_ts on signals (after worker stamp persist)
select
  parsed_data->>'action' as action,
  count(*) as n,
  percentile_cont(0.5) within group (
    order by (
      coalesce((pipeline_ts->>'broker_request_started_at')::bigint, (pipeline_ts->>'t_first_broker_send')::bigint)
      - coalesce((pipeline_ts->>'telegram_message_received_at')::bigint, (pipeline_ts->>'t_listener_received')::bigint)
    )
  ) as p50_receipt_to_broker_ms,
  percentile_cont(0.95) within group (
    order by (
      coalesce((pipeline_ts->>'broker_request_started_at')::bigint, (pipeline_ts->>'t_first_broker_send')::bigint)
      - coalesce((pipeline_ts->>'telegram_message_received_at')::bigint, (pipeline_ts->>'t_listener_received')::bigint)
    )
  ) as p95_receipt_to_broker_ms
from signals
where created_at > now() - interval '24 hours'
  and status in ('executed', 'skipped')
  and pipeline_ts ? 't_listener_received'
  and (
    pipeline_ts ? 'broker_request_started_at'
    or pipeline_ts ? 't_first_broker_send'
    or pipeline_ts ? 't_order_send_start'
  )
group by 1
order by 2 desc;
