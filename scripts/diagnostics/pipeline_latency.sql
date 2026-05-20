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
