-- Snapshot balance at the start of each calendar day (client-local day key) for "today's profit".
alter table public.broker_accounts
  add column if not exists day_start_balance numeric,
  add column if not exists day_start_balance_on date;

comment on column public.broker_accounts.day_start_balance is
  'Account balance at the start of day_start_balance_on (used for dashboard today P/L).';
comment on column public.broker_accounts.day_start_balance_on is
  'Calendar day (YYYY-MM-DD, user-local) for which day_start_balance applies.';
