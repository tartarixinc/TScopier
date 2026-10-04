-- Broker account type (Demo / Live / PropFirm), persisted from MTAPI AccountSummary.
ALTER TABLE broker_accounts
  ADD COLUMN IF NOT EXISTS linked_account_type text
  CHECK (linked_account_type IS NULL OR linked_account_type IN ('Live', 'Demo', 'PropFirm'));

comment on column public.broker_accounts.linked_account_type is
  'Demo / Live / PropFirm, written by the worker from the MT platform account trade mode.';

-- Table-level SELECT was revoked in 20260916120000; grant the new column explicitly.
grant select (linked_account_type) on public.broker_accounts to authenticated;
