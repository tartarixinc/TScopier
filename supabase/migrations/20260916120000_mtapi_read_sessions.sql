-- Phase 2: MTAPI read-session identity and encrypted reconnect credentials.
-- No trading capability is enabled by this migration.

alter table public.broker_accounts
  add column if not exists mtapi_session_id text,
  add column if not exists broker_password_encrypted text,
  add column if not exists auto_reconnect_enabled boolean not null default false,
  add column if not exists password_updated_at timestamptz;

comment on column public.broker_accounts.mtapi_session_id is
  'MTAPI live session token. Service-role only; never expose to browser clients.';
comment on column public.broker_accounts.broker_password_encrypted is
  'AES-256-GCM MT password ciphertext for hard session recovery. Service-role only.';
comment on column public.broker_accounts.auto_reconnect_enabled is
  'Allows worker credential fallback only after ConnectByToken fails.';
comment on column public.broker_accounts.password_updated_at is
  'Timestamp of the latest encrypted MT password write.';

create unique index if not exists broker_accounts_mtapi_session_id_idx
  on public.broker_accounts (mtapi_session_id)
  where mtapi_session_id is not null and btrim(mtapi_session_id) <> '';

-- Table-level SELECT would override a column revoke. Replace the authenticated
-- table grant with explicit grants for every non-secret column present now.
revoke select on table public.broker_accounts from authenticated;
do $$
declare
  safe_columns text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into safe_columns
  from pg_attribute a
  where a.attrelid = 'public.broker_accounts'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and a.attname not in ('broker_password_encrypted', 'mtapi_session_id');
  execute 'grant select (' || safe_columns || ') on public.broker_accounts to authenticated';
end
$$;

create or replace function public.broker_accounts_guard_mtapi_credentials()
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
    new.mtapi_session_id := null;
    new.broker_password_encrypted := null;
    new.auto_reconnect_enabled := false;
    new.password_updated_at := null;
  else
    new.mtapi_session_id := old.mtapi_session_id;
    new.broker_password_encrypted := old.broker_password_encrypted;
    new.auto_reconnect_enabled := old.auto_reconnect_enabled;
    new.password_updated_at := old.password_updated_at;
  end if;
  return new;
end;
$$;

drop trigger if exists broker_accounts_guard_mtapi_credentials
  on public.broker_accounts;
create trigger broker_accounts_guard_mtapi_credentials
before insert or update on public.broker_accounts
for each row execute function public.broker_accounts_guard_mtapi_credentials();
