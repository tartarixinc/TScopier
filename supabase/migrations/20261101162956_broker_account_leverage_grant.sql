-- broker_accounts is readable through column-level grants; the app selects account_leverage
-- (brokerAccountSelect.ts), so authenticated users need SELECT on it or the whole query fails.
grant select (account_leverage) on public.broker_accounts to authenticated;
