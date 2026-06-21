-- When performance_baseline_balance was first snapshotted at successful FxSocket connect.

alter table public.broker_accounts
  add column if not exists performance_baseline_captured_at timestamptz;

comment on column public.broker_accounts.performance_baseline_captured_at is
  'UTC timestamp when performance_baseline_balance was first captured at successful broker connect.';

comment on column public.broker_accounts.performance_baseline_balance is
  'Account balance snapshotted at first successful FxSocket connect; total profit = current balance minus this value (per account).';

update public.broker_accounts
set performance_baseline_captured_at = created_at
where performance_baseline_balance is not null
  and performance_baseline_captured_at is null;
