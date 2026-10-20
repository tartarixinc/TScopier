-- Mirror copy trading engine: worker state, trade ledger, action log, and claim function.
--
-- Same-owner copying (one master broker account -> many slave accounts). This is
-- deliberately separate from social copy trading (cross-user): mirror needs no
-- authorization boundary, but it does need worker-owned lifecycle state kept apart
-- from the user-owned configuration in broker_copy_links.
--
-- Nothing here executes a trade by itself. The worker only reads these tables when
-- its execution flag is on; with the flag off it records intent and touches no broker.

-- ---------------------------------------------------------------------------
-- Master state: one row per account being copied from.
-- Holds the worker lease so two replicas never reconcile the same master at once.
-- ---------------------------------------------------------------------------
create table if not exists public.mirror_copy_master_state (
  broker_account_id uuid primary key references public.broker_accounts(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'active', 'error')),
  error_code text,
  error_detail text,
  lease_owner text,
  lease_expires_at timestamptz,
  last_snapshot_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.mirror_copy_master_state is
  'Worker-owned lease and reconcile state for a mirror-copy master account. Holds no broker credentials.';

-- ---------------------------------------------------------------------------
-- Link state: one row per master->slave link.
-- Kept out of broker_copy_links so worker writes never race the user's settings saves.
-- desired_status is what the user wants; status is what the worker is doing.
-- ---------------------------------------------------------------------------
create table if not exists public.mirror_copy_link_state (
  link_id uuid primary key references public.broker_copy_links(id) on delete cascade,
  desired_status text not null default 'paused' check (desired_status in ('active', 'paused', 'stopped')),
  status text not null default 'pending' check (
    status in ('pending', 'active', 'paused', 'stopped', 'error', 'unsupported_provider')
  ),
  error_code text,
  error_detail text,
  worker_acknowledged_at timestamptz,
  last_reconciled_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.mirror_copy_link_state is
  'Worker-owned lifecycle state for a mirror-copy link. Defaults to paused until the worker acknowledges it.';

-- ---------------------------------------------------------------------------
-- Trade ledger: one row per copied trade (master ticket -> slave ticket).
-- This is what lets the worker survive a restart and never copy a trade twice.
-- ---------------------------------------------------------------------------
create table if not exists public.mirror_copy_trade_mappings (
  id uuid primary key default gen_random_uuid(),
  -- Cascade, not restrict: broker_copy_links rows are hard-deleted by the existing
  -- config UI, and an unmanaged copy has no meaning once its link is gone.
  link_id uuid not null references public.broker_copy_links(id) on delete cascade,
  source_ticket text not null,
  destination_ticket text,
  source_symbol text not null,
  destination_symbol text not null,
  source_side text not null check (source_side in ('buy', 'sell')),
  source_volume numeric not null check (source_volume > 0),
  destination_volume numeric not null check (destination_volume > 0),
  source_stop_loss numeric,
  source_take_profit numeric,
  state text not null default 'opening' check (
    state in ('opening', 'open', 'closing', 'closed', 'uncertain', 'error')
  ),
  broker_comment text not null,
  opened_at timestamptz,
  closed_at timestamptz,
  last_error_code text,
  last_error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (link_id, source_ticket),
  unique (link_id, broker_comment)
);

comment on table public.mirror_copy_trade_mappings is
  'Links a master ticket to its copied slave ticket for one mirror link. Enforces one copy per source ticket.';

-- ---------------------------------------------------------------------------
-- Action log: one row per intended broker action, written before it is sent.
-- The unique (link_id, idempotency_key) is the duplicate protection.
-- ---------------------------------------------------------------------------
create table if not exists public.mirror_copy_execution_events (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.broker_copy_links(id) on delete cascade,
  mapping_id uuid references public.mirror_copy_trade_mappings(id) on delete cascade,
  source_ticket text not null,
  action text not null check (action in ('open', 'modify', 'close', 'unsupported', 'reconcile')),
  idempotency_key text not null,
  status text not null default 'claimed' check (
    status in ('claimed', 'succeeded', 'failed', 'uncertain', 'skipped')
  ),
  attempt_count integer not null default 1 check (attempt_count > 0),
  request_payload jsonb not null default '{}'::jsonb,
  result_payload jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (link_id, idempotency_key)
);

comment on table public.mirror_copy_execution_events is
  'Durable audit and idempotency record for mirror-copy broker actions. A failed action may be re-claimed; any other status blocks a repeat.';

create index if not exists mirror_copy_master_state_claim_idx
  on public.mirror_copy_master_state (status, lease_expires_at);
create index if not exists mirror_copy_link_state_worker_idx
  on public.mirror_copy_link_state (desired_status, status);
create index if not exists mirror_copy_trade_mappings_open_idx
  on public.mirror_copy_trade_mappings (link_id, state);
create index if not exists mirror_copy_execution_events_link_idx
  on public.mirror_copy_execution_events (link_id, created_at desc);
create index if not exists mirror_copy_execution_events_mapping_idx
  on public.mirror_copy_execution_events (mapping_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_mirror_copy_updated_at()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists mirror_copy_master_state_updated_at on public.mirror_copy_master_state;
create trigger mirror_copy_master_state_updated_at before update on public.mirror_copy_master_state
  for each row execute function public.set_mirror_copy_updated_at();
drop trigger if exists mirror_copy_link_state_updated_at on public.mirror_copy_link_state;
create trigger mirror_copy_link_state_updated_at before update on public.mirror_copy_link_state
  for each row execute function public.set_mirror_copy_updated_at();
drop trigger if exists mirror_copy_trade_mappings_updated_at on public.mirror_copy_trade_mappings;
create trigger mirror_copy_trade_mappings_updated_at before update on public.mirror_copy_trade_mappings
  for each row execute function public.set_mirror_copy_updated_at();
drop trigger if exists mirror_copy_execution_events_updated_at on public.mirror_copy_execution_events;
create trigger mirror_copy_execution_events_updated_at before update on public.mirror_copy_execution_events
  for each row execute function public.set_mirror_copy_updated_at();

-- ---------------------------------------------------------------------------
-- Seed state rows whenever a link is created, so the UI can show status before
-- the worker's next run and the claim function always has a master row.
-- Links start paused and are activated deliberately through
-- set_mirror_copy_link_status(); this keeps a config change from starting live copying.
-- ---------------------------------------------------------------------------
create or replace function public.mirror_copy_link_after_insert()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.mirror_copy_link_state (link_id)
    values (new.id)
    on conflict (link_id) do nothing;
  insert into public.mirror_copy_master_state (broker_account_id)
    values (new.source_broker_account_id)
    on conflict (broker_account_id) do nothing;
  return new;
end;
$$;

drop trigger if exists mirror_copy_link_after_insert on public.broker_copy_links;
create trigger mirror_copy_link_after_insert after insert on public.broker_copy_links
  for each row execute function public.mirror_copy_link_after_insert();

-- Backfill state for any links that already existed before this migration, so the
-- claim function has a master row and the UI has a link state row for every link.
insert into public.mirror_copy_link_state (link_id)
  select id from public.broker_copy_links
  on conflict (link_id) do nothing;
insert into public.mirror_copy_master_state (broker_account_id)
  select distinct source_broker_account_id from public.broker_copy_links
  on conflict (broker_account_id) do nothing;

-- ---------------------------------------------------------------------------
-- Claim function: hand each worker a share of the masters under a short lease.
-- Service-role only. Mirrors claim_social_copy_subscriptions.
-- ---------------------------------------------------------------------------
create or replace function public.claim_mirror_copy_masters(
  p_worker text,
  p_limit integer default 50,
  p_lease_seconds integer default 60
)
returns setof public.mirror_copy_master_state
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  -- Access control is the GRANT below (execute is revoked from public/anon/authenticated
  -- and granted only to service_role). An in-body current_user check would be useless
  -- here: inside a SECURITY DEFINER function current_user is the function owner, not the
  -- caller, so it would silently pass for any role if the grant were ever widened.
  return query
  with candidates as (
    select m.broker_account_id
    from public.mirror_copy_master_state m
    where exists (
        select 1 from public.broker_copy_links l
        where l.source_broker_account_id = m.broker_account_id
      )
      and (m.lease_expires_at is null or m.lease_expires_at < now() or m.lease_owner = p_worker)
    order by coalesce(m.last_reconciled_at, m.created_at), m.broker_account_id
    for update skip locked
    limit greatest(1, least(p_limit, 200))
  )
  update public.mirror_copy_master_state m set
    lease_owner = p_worker,
    lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300)))
  from candidates c
  where m.broker_account_id = c.broker_account_id
  returning m.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- User-facing lifecycle switch (activate / pause / stop). This is the only way a
-- user changes desired_status; the worker alone writes the current `status`.
-- ---------------------------------------------------------------------------
create or replace function public.set_mirror_copy_link_status(p_link_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_status is null or p_status not in ('active', 'paused', 'stopped') then
    raise exception 'invalid mirror copy status: %', p_status using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.broker_copy_links l
    where l.id = p_link_id
      and (l.user_id = auth.uid() or auth.role() = 'service_role')
  ) then
    raise exception 'not authorized for this mirror copy link' using errcode = '42501';
  end if;
  insert into public.mirror_copy_link_state (link_id, desired_status)
    values (p_link_id, p_status)
    on conflict (link_id) do update set desired_status = excluded.desired_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissions: worker writes everything; a user may only read their own link state,
-- plus call the lifecycle RPC above for their own links.
-- ---------------------------------------------------------------------------
alter table public.mirror_copy_master_state enable row level security;
alter table public.mirror_copy_link_state enable row level security;
alter table public.mirror_copy_trade_mappings enable row level security;
alter table public.mirror_copy_execution_events enable row level security;

revoke all on table public.mirror_copy_master_state from anon, authenticated;
revoke all on table public.mirror_copy_link_state from anon, authenticated;
revoke all on table public.mirror_copy_trade_mappings from anon, authenticated;
revoke all on table public.mirror_copy_execution_events from anon, authenticated;

grant all on table public.mirror_copy_master_state to service_role;
grant all on table public.mirror_copy_link_state to service_role;
grant all on table public.mirror_copy_trade_mappings to service_role;
grant all on table public.mirror_copy_execution_events to service_role;

grant select on table public.mirror_copy_link_state to authenticated;

drop policy if exists "Users can view own mirror copy link state" on public.mirror_copy_link_state;
create policy "Users can view own mirror copy link state"
  on public.mirror_copy_link_state for select to authenticated
  using (exists (
    select 1 from public.broker_copy_links l
    where l.id = link_id and l.user_id = auth.uid()
  ));

revoke all on function public.set_mirror_copy_updated_at() from public, anon, authenticated;
revoke all on function public.mirror_copy_link_after_insert() from public, anon, authenticated;
revoke all on function public.claim_mirror_copy_masters(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_mirror_copy_masters(text, integer, integer) to service_role;

revoke all on function public.set_mirror_copy_link_status(uuid, text) from public, anon;
grant execute on function public.set_mirror_copy_link_status(uuid, text) to authenticated, service_role;
