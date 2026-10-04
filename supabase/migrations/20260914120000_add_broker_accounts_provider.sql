-- Add provider column to broker_accounts for MTAPI migration.
-- Default 'fxsocket' preserves existing behaviour; MTAPI accounts get 'mtapi'.
-- Idempotent: the column and constraint may already exist on environments where
-- this ran before the version was registered in schema_migrations.

alter table broker_accounts
  add column if not exists provider text not null default 'fxsocket';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'broker_accounts_provider_check'
      and conrelid = 'public.broker_accounts'::regclass
  ) then
    alter table broker_accounts
      add constraint broker_accounts_provider_check
        check (provider in ('fxsocket', 'mtapi'));
  end if;
end $$;

comment on column broker_accounts.provider is
  'Broker provider: fxsocket (default) or mtapi. Controls which BrokerProvider implementation handles this account.';

-- Index for provider-based queries (Phase 2 startup reconciliation).
create index if not exists broker_accounts_provider_idx
  on broker_accounts (provider)
  where provider != 'fxsocket';
