-- Broker accounts can be placed on the configuration map as copy sources.
-- Links record which destination should later copy that source. The worker does not read these yet.

alter table public.broker_accounts
  add column if not exists copy_source boolean not null default false;

comment on column public.broker_accounts.copy_source is
  'When true, this account is a copy source and is shown only on the left of the configuration map.';

grant select (copy_source) on public.broker_accounts to authenticated;
grant update (copy_source) on public.broker_accounts to authenticated;

create table if not exists public.broker_copy_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  destination_broker_account_id uuid not null references public.broker_accounts(id) on delete cascade,
  manual_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint broker_copy_links_distinct
    check (source_broker_account_id <> destination_broker_account_id),
  constraint broker_copy_links_pair_unique
    unique (source_broker_account_id, destination_broker_account_id)
);

create index if not exists broker_copy_links_user_idx
  on public.broker_copy_links (user_id);

create index if not exists broker_copy_links_destination_idx
  on public.broker_copy_links (destination_broker_account_id);

comment on table public.broker_copy_links is
  'Saved configuration-map link from a source broker to a destination broker. Not executed by the worker yet.';

grant select, insert, update, delete on public.broker_copy_links to authenticated;
grant select, insert, update, delete on public.broker_copy_links to service_role;

alter table public.broker_copy_links enable row level security;

drop policy if exists "Users can view own broker copy links" on public.broker_copy_links;
create policy "Users can view own broker copy links"
  on public.broker_copy_links for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own broker copy links" on public.broker_copy_links;
create policy "Users can insert own broker copy links"
  on public.broker_copy_links for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.broker_accounts src
      where src.id = source_broker_account_id and src.user_id = auth.uid()
    )
    and exists (
      select 1 from public.broker_accounts dst
      where dst.id = destination_broker_account_id and dst.user_id = auth.uid()
    )
  );

drop policy if exists "Users can update own broker copy links" on public.broker_copy_links;
create policy "Users can update own broker copy links"
  on public.broker_copy_links for update
  to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.broker_accounts src
      where src.id = source_broker_account_id and src.user_id = auth.uid()
    )
    and exists (
      select 1 from public.broker_accounts dst
      where dst.id = destination_broker_account_id and dst.user_id = auth.uid()
    )
  );

drop policy if exists "Users can delete own broker copy links" on public.broker_copy_links;
create policy "Users can delete own broker copy links"
  on public.broker_copy_links for delete
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.set_broker_copy_links_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists broker_copy_links_updated_at on public.broker_copy_links;
create trigger broker_copy_links_updated_at
  before update on public.broker_copy_links
  for each row
  execute function public.set_broker_copy_links_updated_at();
