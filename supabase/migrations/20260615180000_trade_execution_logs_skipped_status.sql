-- Allow skip outcomes in trade_execution_logs (mgmt_skip, dispatch_skipped, CWE skips).
alter table public.trade_execution_logs
  drop constraint if exists trade_execution_logs_status_check;

alter table public.trade_execution_logs
  add constraint trade_execution_logs_status_check
  check (status in ('attempt', 'success', 'failed', 'skipped'));
