-- Broker API integration: split MT login from API UUID, cache live account data,
-- and add a clean broker label on mt_servers for the new typeahead.

alter table public.broker_accounts
  add column if not exists account_login text;

alter table public.broker_accounts
  add column if not exists broker_name text;

alter table public.broker_accounts
  add column if not exists connection_status text not null default 'pending'
    check (connection_status in ('pending', 'connected', 'error'));

alter table public.broker_accounts
  add column if not exists last_balance numeric;

alter table public.broker_accounts
  add column if not exists last_equity numeric;

alter table public.broker_accounts
  add column if not exists last_currency text;

alter table public.broker_accounts
  add column if not exists last_synced_at timestamptz;

comment on column public.broker_accounts.metaapi_account_id is
  'FxSocket account UUID returned by /RegisterAccount. Used as the id query param for every broker API call.';

comment on column public.broker_accounts.account_login is
  'MT login number (separate from the API UUID).';

comment on column public.broker_accounts.broker_name is
  'Human display name (e.g. "IC Markets") inferred from broker_server when not provided by the API.';

comment on column public.broker_accounts.connection_status is
  'pending | connected | error — last known status from /CheckConnect or /RegisterAccount.';

-- Backfill account_login from legacy "server|login" metaapi_account_id format.
update public.broker_accounts
set account_login = nullif(btrim(split_part(metaapi_account_id, '|', 2)), '')
where coalesce(account_login, '') = ''
  and position('|' in metaapi_account_id) > 0;

-- mt_servers grouping label for the broker-server typeahead.
alter table public.mt_servers
  add column if not exists broker_label text;

comment on column public.mt_servers.broker_label is
  'Optional human broker name used to group servers in the typeahead (e.g. "IC Markets" for ICMarketsSC-MT5-2).';

-- Best-effort backfill from server name. Front-end inferBrokerLabelFromServer applies the same rules.
update public.mt_servers
set broker_label = case
  when broker_label is not null and btrim(broker_label) <> '' then broker_label
  when lower(server_name) like '%icmarkets%' then 'IC Markets'
  when lower(server_name) like '%exness%' then 'Exness'
  when lower(server_name) like '%ftmo%' then 'FTMO'
  when lower(server_name) like '%deriv%' then 'Deriv'
  when lower(server_name) like '%eightcap%' then 'Eightcap'
  when lower(server_name) like '%vpfx%' then 'VPFX'
  when lower(server_name) like '%m4markets%' then 'M4 Markets'
  when lower(server_name) like '%olympicmarkets%' then 'Olympic Markets'
  when lower(server_name) like '%hfmarkets%' then 'HFM'
  when lower(server_name) like '%fxdd%' then 'FXDD'
  when lower(server_name) like '%vtmarkets%' then 'VT Markets'
  when lower(server_name) like '%lmax%' then 'LMAX'
  when lower(server_name) like '%robomarkets%' then 'RoboMarkets'
  when lower(server_name) like '%trading.com%' then 'Trading.com'
  when lower(server_name) like '%metaquotes%' then 'MetaQuotes'
  when lower(server_name) like '%pepperstone%' then 'Pepperstone'
  when lower(server_name) like '%oanda%' then 'OANDA'
  when lower(server_name) like '%fxtm%' then 'FXTM'
  when lower(server_name) like '%admiral%' then 'Admirals'
  when lower(server_name) like '%tickmill%' then 'Tickmill'
  when lower(server_name) like '%thinkmarkets%' then 'ThinkMarkets'
  when lower(server_name) like '%vantage%' then 'Vantage'
  when lower(server_name) like '%fusion markets%' then 'Fusion Markets'
  when lower(server_name) like '%global prime%' then 'Global Prime'
  when lower(server_name) like '%xm.com%' or lower(server_name) like '%xmglobal%' or lower(server_name) like 'xm-%' then 'XM'
  when lower(server_name) like '%justmarkets%' then 'JustMarkets'
  when lower(server_name) like '%axi%' then 'Axi'
  when lower(server_name) like '%fp markets%' then 'FP Markets'
  when lower(server_name) like '%blackbull%' then 'BlackBull'
  when lower(server_name) like '%blueberry%' then 'Blueberry'
  when lower(server_name) like '%dukascopy%' then 'Dukascopy'
  else initcap(split_part(replace(replace(server_name, '_', '-'), '/', '-'), '-', 1))
end
where broker_label is null or btrim(broker_label) = '';

create index if not exists mt_servers_broker_label_idx
  on public.mt_servers(broker_label);

-- Worker tradeExecutor subscribes to these tables via Supabase Realtime; ensure
-- the publication includes them so postgres_changes events are delivered.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'signals'
  ) then
    execute 'alter publication supabase_realtime add table public.signals';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'broker_accounts'
  ) then
    execute 'alter publication supabase_realtime add table public.broker_accounts';
  end if;
end$$;
