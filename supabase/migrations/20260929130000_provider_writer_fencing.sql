-- Phase 4C: durable single-writer authority and distributed mutation leases.
-- Existing rows remain stable FXSocket/MTAPI writers at epoch 1.

alter table public.broker_accounts
  add column if not exists writer_epoch bigint not null default 1,
  add column if not exists provider_transition_state text not null default 'stable',
  add column if not exists provider_transition_target text;

alter table public.broker_accounts
  drop constraint if exists broker_accounts_writer_epoch_check,
  add constraint broker_accounts_writer_epoch_check check (writer_epoch > 0),
  drop constraint if exists broker_accounts_provider_transition_state_check,
  add constraint broker_accounts_provider_transition_state_check
    check (provider_transition_state in ('stable', 'transition')),
  drop constraint if exists broker_accounts_provider_transition_target_check,
  add constraint broker_accounts_provider_transition_target_check
    check (provider_transition_target is null or provider_transition_target in ('fxsocket', 'mtapi')),
  drop constraint if exists broker_accounts_provider_transition_shape_check,
  add constraint broker_accounts_provider_transition_shape_check check (
    (provider_transition_state = 'stable' and provider_transition_target is null)
    or
    (provider_transition_state = 'transition'
      and provider_transition_target is not null
      and provider_transition_target <> provider)
  );

comment on column public.broker_accounts.writer_epoch is
  'Monotonic broker-writer fence. Every provider transition increments it before draining writes.';
comment on column public.broker_accounts.provider_transition_state is
  'stable permits the selected provider to acquire write leases; transition blocks all new broker writes.';
comment on column public.broker_accounts.provider_transition_target is
  'Internal provider target while provider_transition_state=transition; NULL while stable.';

grant select (writer_epoch, provider_transition_state, provider_transition_target)
  on public.broker_accounts to authenticated;

create table if not exists public.broker_write_leases (
  id uuid primary key default gen_random_uuid(),
  broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  writer_epoch bigint not null,
  provider text not null check (provider in ('fxsocket', 'mtapi')),
  operation text not null check (char_length(operation) between 1 and 80),
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);

create index if not exists broker_write_leases_active_idx
  on public.broker_write_leases (broker_account_id, expires_at);

alter table public.broker_write_leases enable row level security;
revoke all on table public.broker_write_leases from anon, authenticated;
grant all on table public.broker_write_leases to service_role;

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
  if p_expected_provider not in ('fxsocket', 'mtapi')
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

create or replace function public.renew_broker_write_lease(
  p_lease_id uuid,
  p_ttl_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.broker_write_leases l
  set expires_at = clock_timestamp() + make_interval(secs => greatest(10, least(p_ttl_seconds, 300)))
  from public.broker_accounts b
  where l.id = p_lease_id
    and b.id = l.broker_account_id
    and b.provider = l.provider
    and (
      (b.provider_transition_state = 'stable' and b.writer_epoch = l.writer_epoch)
      or
      (b.provider_transition_state = 'transition' and b.writer_epoch = l.writer_epoch + 1)
    )
    and l.expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.release_broker_write_lease(p_lease_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.broker_write_leases where id = p_lease_id;
$$;

create or replace function public.begin_broker_provider_transition(
  p_broker_account_id uuid,
  p_expected_provider text,
  p_target_provider text,
  p_expected_session_id text,
  p_expected_writer_epoch bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  next_epoch bigint;
begin
  if p_expected_provider not in ('fxsocket', 'mtapi')
    or p_target_provider not in ('fxsocket', 'mtapi')
    or p_expected_provider = p_target_provider then
    raise exception using errcode = 'P0001', message = 'BROKER_PROVIDER_TRANSITION_REJECTED';
  end if;

  update public.broker_accounts
  set provider_transition_state = 'transition',
      provider_transition_target = p_target_provider,
      writer_epoch = writer_epoch + 1,
      updated_at = now()
  where id = p_broker_account_id
    and provider_transition_state = 'stable'
    and provider_transition_target is null
    and provider = p_expected_provider
    and writer_epoch = p_expected_writer_epoch
    and case provider
      when 'mtapi' then nullif(btrim(mtapi_session_id), '') = btrim(p_expected_session_id)
      else coalesce(nullif(btrim(fxsocket_account_id), ''), nullif(btrim(metaapi_account_id), '')) = btrim(p_expected_session_id)
    end
  returning writer_epoch into next_epoch;

  if next_epoch is null then
    raise exception using errcode = 'P0001', message = 'BROKER_PROVIDER_TRANSITION_REJECTED';
  end if;
  return next_epoch;
end;
$$;

create or replace function public.count_broker_write_leases(
  p_broker_account_id uuid,
  p_before_writer_epoch bigint
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  lease_count integer;
begin
  delete from public.broker_write_leases
  where broker_account_id = p_broker_account_id and expires_at <= clock_timestamp();
  select count(*)::integer into lease_count
  from public.broker_write_leases
  where broker_account_id = p_broker_account_id
    and writer_epoch < p_before_writer_epoch
    and expires_at > clock_timestamp();
  return lease_count;
end;
$$;

create or replace function public.finish_broker_provider_transition(
  p_broker_account_id uuid,
  p_expected_provider text,
  p_target_provider text,
  p_transition_writer_epoch bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  final_epoch bigint;
begin
  delete from public.broker_write_leases
  where broker_account_id = p_broker_account_id and expires_at <= clock_timestamp();

  if exists (
    select 1 from public.broker_write_leases
    where broker_account_id = p_broker_account_id
      and writer_epoch < p_transition_writer_epoch
      and expires_at > clock_timestamp()
  ) then
    raise exception using errcode = 'P0001', message = 'BROKER_PROVIDER_WRITES_NOT_DRAINED';
  end if;

  update public.broker_accounts
  set provider = p_target_provider,
      provider_transition_state = 'stable',
      provider_transition_target = null,
      updated_at = now()
  where id = p_broker_account_id
    and provider = p_expected_provider
    and provider_transition_state = 'transition'
    and provider_transition_target = p_target_provider
    and writer_epoch = p_transition_writer_epoch
  returning writer_epoch into final_epoch;

  if final_epoch is null then
    raise exception using errcode = 'P0001', message = 'BROKER_PROVIDER_TRANSITION_REJECTED';
  end if;
  return final_epoch;
end;
$$;

create or replace function public.abort_broker_provider_transition(
  p_broker_account_id uuid,
  p_expected_provider text,
  p_target_provider text,
  p_transition_writer_epoch bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.broker_accounts
  set provider_transition_state = 'stable',
      provider_transition_target = null,
      updated_at = now()
  where id = p_broker_account_id
    and provider = p_expected_provider
    and provider_transition_state = 'transition'
    and provider_transition_target = p_target_provider
    and writer_epoch = p_transition_writer_epoch;
  return found;
end;
$$;

revoke all on function public.acquire_broker_write_lease(uuid, text, text, bigint, text, integer) from public, anon, authenticated;
revoke all on function public.renew_broker_write_lease(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_broker_write_lease(uuid) from public, anon, authenticated;
revoke all on function public.begin_broker_provider_transition(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.count_broker_write_leases(uuid, bigint) from public, anon, authenticated;
revoke all on function public.finish_broker_provider_transition(uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.abort_broker_provider_transition(uuid, text, text, bigint) from public, anon, authenticated;

grant execute on function public.acquire_broker_write_lease(uuid, text, text, bigint, text, integer) to service_role;
grant execute on function public.renew_broker_write_lease(uuid, integer) to service_role;
grant execute on function public.release_broker_write_lease(uuid) to service_role;
grant execute on function public.begin_broker_provider_transition(uuid, text, text, text, bigint) to service_role;
grant execute on function public.count_broker_write_leases(uuid, bigint) to service_role;
grant execute on function public.finish_broker_provider_transition(uuid, text, text, bigint) to service_role;
grant execute on function public.abort_broker_provider_transition(uuid, text, text, bigint) to service_role;

create or replace function public.broker_accounts_guard_writer_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  jwt_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  if jwt_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.provider := 'fxsocket';
    new.writer_epoch := 1;
    new.provider_transition_state := 'stable';
    new.provider_transition_target := null;
  else
    new.provider := old.provider;
    new.writer_epoch := old.writer_epoch;
    new.provider_transition_state := old.provider_transition_state;
    new.provider_transition_target := old.provider_transition_target;
  end if;
  return new;
end;
$$;

drop trigger if exists broker_accounts_guard_writer_authority on public.broker_accounts;
create trigger broker_accounts_guard_writer_authority
before insert or update on public.broker_accounts
for each row execute function public.broker_accounts_guard_writer_authority();
