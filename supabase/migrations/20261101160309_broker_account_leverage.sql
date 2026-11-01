-- Account leverage (e.g. 500 means 1:500) as reported by the broker summary; written by the
-- broker edge functions on each summary refresh. Display only.
alter table public.broker_accounts
  add column if not exists account_leverage integer;

comment on column public.broker_accounts.account_leverage is
  'Account leverage reported by the broker (500 = 1:500). Written by broker edge functions on summary refresh.';
