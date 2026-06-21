-- Persist MT server string for display and broker-name inference (FxSocket uses opaque account ids).
alter table public.broker_accounts
  add column if not exists broker_server text;

comment on column public.broker_accounts.broker_server is 'MT login server name as entered at connection (e.g. ICMarketsEU-MT5-5).';

-- Backfill from legacy metaapi_account_id format server|login
update public.broker_accounts
set broker_server = nullif(btrim(split_part(metaapi_account_id, '|', 1)), '')
where coalesce(broker_server, '') = ''
  and position('|' in metaapi_account_id) > 0
  and nullif(btrim(split_part(metaapi_account_id, '|', 1)), '') is not null;
