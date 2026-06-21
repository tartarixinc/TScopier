-- Pipeline latency percentiles (P50/P99) for copy speed monitoring.
-- Run in Supabase SQL Editor after deploy; use for shard health and alerting.

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
