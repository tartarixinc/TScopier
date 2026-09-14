-- Add provider column to broker_accounts for MTAPI migration.
-- Default 'fxsocket' preserves existing behaviour; MTAPI accounts get 'mtapi'.

alter table broker_accounts
  add column provider text not null default 'fxsocket';

comment on column broker_accounts.provider is
  'Broker provider: fxsocket (default) or mtapi. Controls which BrokerProvider implementation handles this account.';

-- Index for provider-based queries (Phase 2 startup reconciliation).
create index broker_accounts_provider_idx
  on broker_accounts (provider)
  where provider != 'fxsocket';
