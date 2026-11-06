-- Admin-granted access extensions.
--
-- A ledger of extra days granted by an admin after a trial or paid period
-- ends. The subscriptions row is never edited: Stripe keeps syncing that row
-- and would overwrite any manual change. Access checks read this table as a
-- third option: subscription active, or trial not over, or a live grant.

create table if not exists public.subscription_extensions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (user_id) on delete cascade,
  days integer not null check (days > 0 and days <= 30),
  reason text not null,
  granted_by uuid,
  granted_at timestamptz not null default now()
);

create index if not exists subscription_extensions_user_idx
  on public.subscription_extensions (user_id, granted_at desc);

alter table public.subscription_extensions enable row level security;

drop policy if exists "Users can read own subscription extensions"
  on public.subscription_extensions;
create policy "Users can read own subscription extensions"
  on public.subscription_extensions for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

-- No insert/update/delete policy on purpose: grants are written only by the
-- admin-mutate edge function (service role), which also writes the audit row.

insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
values (
  '20261105230000',
  '20261105230000_subscription_extensions',
  array['-- 20261105230000_subscription_extensions']::text[],
  'opencode-controlled-apply'
)
on conflict (version) do nothing;
