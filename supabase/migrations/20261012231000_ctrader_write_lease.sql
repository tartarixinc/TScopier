-- Let the copy worker take a write lease for cTrader accounts.
-- The lease previously rejected every provider other than fxsocket and mtapi,
-- so a linked cTrader account could not receive orderSend.

do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'broker_write_leases'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%provider%';
  if constraint_name is not null then
    execute format('alter table public.broker_write_leases drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.broker_write_leases
  drop constraint if exists broker_write_leases_provider_check;

alter table public.broker_write_leases
  add constraint broker_write_leases_provider_check
    check (provider in ('fxsocket', 'mtapi', 'ctrader'));

create or replace function public.acquire_broker_write_lease(
  p_broker_account_id uuid,
  p_expected_provider text,
  p_expected_session_id text,
  p_expected_writer_epoch bigint,
  p_operation text,
  p_ttl_seconds integer default 120
)
returns table(lease_id uuid, writer_epoch bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  account_row public.broker_accounts%rowtype;
  authoritative_session text;
  new_lease_id uuid;
begin
  if p_expected_provider not in ('fxsocket', 'mtapi', 'ctrader')
    or nullif(btrim(coalesce(p_expected_session_id, '')), '') is null
    or p_expected_writer_epoch is null
    or nullif(btrim(coalesce(p_operation, '')), '') is null then
    raise exception using errcode = 'P0001', message = 'BROKER_WRITE_FENCE_REJECTED';
  end if;

  select * into account_row
  from public.broker_accounts
  where id = p_broker_account_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'BROKER_WRITE_FENCE_REJECTED';
  end if;

  authoritative_session := case account_row.provider
    when 'mtapi' then nullif(btrim(account_row.mtapi_session_id), '')
    when 'ctrader' then nullif(btrim(account_row.ctrader_account_id), '')
    else coalesce(
      nullif(btrim(account_row.fxsocket_account_id), ''),
      nullif(btrim(account_row.metaapi_account_id), '')
    )
  end;

  if account_row.provider_transition_state <> 'stable'
    or account_row.provider <> p_expected_provider
    or account_row.writer_epoch <> p_expected_writer_epoch
    or authoritative_session is distinct from btrim(p_expected_session_id) then
    raise exception using errcode = 'P0001', message = 'BROKER_WRITE_FENCE_REJECTED';
  end if;

  delete from public.broker_write_leases
  where broker_account_id = p_broker_account_id and expires_at <= clock_timestamp();

  insert into public.broker_write_leases (
    broker_account_id, writer_epoch, provider, operation, expires_at
  ) values (
    p_broker_account_id,
    account_row.writer_epoch,
    account_row.provider,
    left(btrim(p_operation), 80),
    clock_timestamp() + make_interval(secs => greatest(10, least(p_ttl_seconds, 300)))
  ) returning id into new_lease_id;

  return query select new_lease_id, account_row.writer_epoch;
end;
$$;
