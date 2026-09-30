-- Provider-specific MTAPI lifecycle status.
-- NULL means MTAPI status is not applicable or has not yet been observed.

alter table public.broker_accounts
  add column if not exists mtapi_status text;

-- Keep this column nullable with no default so existing FXSocket rows remain
-- semantically unchanged and new MTAPI rows can fall back to connection_status
-- until the edge function or worker records a provider-specific state.
alter table public.broker_accounts
  alter column mtapi_status drop default,
  alter column mtapi_status drop not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'broker_accounts_mtapi_status_check'
      and conrelid = 'public.broker_accounts'::regclass
  ) then
    alter table public.broker_accounts
      add constraint broker_accounts_mtapi_status_check
      check (mtapi_status in ('connecting', 'connected', 'error', 'disconnected'));
  end if;
end
$$;

comment on column public.broker_accounts.mtapi_status is
  'MTAPI lifecycle status: connecting | connected | error | disconnected. NULL when not applicable or not yet observed.';

-- Authenticated table SELECT was replaced by explicit column grants in
-- 20260916120000_mtapi_read_sessions.sql.
grant select (mtapi_status) on public.broker_accounts to authenticated;
