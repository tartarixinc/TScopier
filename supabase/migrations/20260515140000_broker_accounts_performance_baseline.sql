/*
  # broker_accounts — performance baseline for dashboard total profit

  Total profit on the dashboard is defined as (current equity − baseline balance)
  per linked broker, summed across accounts that have a baseline.

  The baseline is set when the account is first registered (first AccountSummary
  balance) or on the first successful summary after this column exists, so it
  approximates "original balance" at the start of tracking in TScopier.
*/

alter table public.broker_accounts
  add column if not exists performance_baseline_balance numeric;

comment on column public.broker_accounts.performance_baseline_balance is
  'Balance captured at first link or first summary after rollout; total profit = current equity minus this value (per account).';
