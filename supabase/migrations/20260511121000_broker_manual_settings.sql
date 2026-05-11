alter table public.broker_accounts
  add column if not exists manual_settings jsonb not null default '{}'::jsonb;

comment on column public.broker_accounts.manual_settings is
  'Manual copier mode configuration (symbol routing, risk, TP sizing, trade style, filters, management rules).';
