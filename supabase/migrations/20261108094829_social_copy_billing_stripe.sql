/*
  Copier → provider Stripe billing (Connect destination charges).

  - social_copy_billing: one entitlement row per payer+provider
  - social_profiles: provider Connect account readiness
  - wallet_ledger: Stripe invoice / payment intent ids
  - Gate create_social_copy_subscription on active paid entitlement
  - Require Connect charges_enabled before publishing a paid monthly price
*/

-- 1. Provider Connect readiness on social_profiles --------------------------------------
alter table public.social_profiles
  add column if not exists stripe_connect_account_id text,
  add column if not exists stripe_connect_charges_enabled boolean not null default false;

comment on column public.social_profiles.stripe_connect_account_id is
  'Stripe Connect Express account for receiving social copy subscription destination charges.';
comment on column public.social_profiles.stripe_connect_charges_enabled is
  'True when the provider Connect account can receive charges (charges_enabled).';

-- 2. wallet_ledger Stripe settlement ids ------------------------------------------------
alter table public.wallet_ledger
  add column if not exists stripe_invoice_id text,
  add column if not exists stripe_payment_intent_id text;

create unique index if not exists wallet_ledger_stripe_invoice_id_key
  on public.wallet_ledger (stripe_invoice_id)
  where stripe_invoice_id is not null;

-- 3. social_copy_billing ----------------------------------------------------------------
create table if not exists public.social_copy_billing (
  id uuid primary key default gen_random_uuid(),
  payer_user_id uuid not null references auth.users(id) on delete cascade,
  provider_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'incomplete',
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  wallet_ledger_id uuid references public.wallet_ledger(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_copy_billing_not_self check (payer_user_id <> provider_user_id),
  constraint social_copy_billing_status_check
    check (status in ('incomplete', 'active', 'past_due', 'canceled')),
  constraint social_copy_billing_payer_provider_key unique (payer_user_id, provider_user_id)
);

create index if not exists social_copy_billing_provider_user_id_idx
  on public.social_copy_billing (provider_user_id, status);

create index if not exists social_copy_billing_stripe_subscription_id_idx
  on public.social_copy_billing (stripe_subscription_id)
  where stripe_subscription_id is not null;

create unique index if not exists social_copy_billing_stripe_subscription_id_key
  on public.social_copy_billing (stripe_subscription_id)
  where stripe_subscription_id is not null;

alter table public.social_copy_billing enable row level security;

drop policy if exists "Users can view own social copy billing" on public.social_copy_billing;
create policy "Users can view own social copy billing"
  on public.social_copy_billing
  for select
  to authenticated
  using (auth.uid() = payer_user_id or auth.uid() = provider_user_id);

create or replace function public.touch_social_copy_billing_updated_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists social_copy_billing_touch_updated_at on public.social_copy_billing;
create trigger social_copy_billing_touch_updated_at
  before update on public.social_copy_billing
  for each row
  execute function public.touch_social_copy_billing_updated_at();

-- 4. Active entitlement helper ----------------------------------------------------------
create or replace function public.has_active_social_copy_billing(
  p_payer_user_id uuid,
  p_provider_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.social_copy_billing b
    where b.payer_user_id = p_payer_user_id
      and b.provider_user_id = p_provider_user_id
      and b.status = 'active'
      and (b.current_period_end is null or b.current_period_end > now())
  );
$$;

revoke all on function public.has_active_social_copy_billing(uuid, uuid) from public, anon;
grant execute on function public.has_active_social_copy_billing(uuid, uuid) to authenticated, service_role;

-- 5. Service-role pause/stop for billing failures ---------------------------------------
create or replace function public.pause_social_copy_subscriptions_for_billing(
  p_payer_user_id uuid,
  p_provider_user_id uuid,
  p_action text default 'pause'
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer := 0;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_action not in ('pause', 'stop') then
    raise exception 'Invalid billing pause action' using errcode = '22023';
  end if;

  update public.social_copy_subscriptions
  set
    desired_status = case when p_action = 'pause' then 'paused' else 'stopped' end,
    status = 'pending',
    error_code = case when p_action = 'pause' then 'BILLING_PAST_DUE' else 'BILLING_CANCELED' end,
    error_detail = case
      when p_action = 'pause' then 'Copy paused because the provider subscription payment failed'
      else 'Copy stopped because the provider subscription was canceled'
    end,
    stopped_at = case when p_action = 'stop' then now() else stopped_at end
  where subscriber_user_id = p_payer_user_id
    and source_trader_user_id = p_provider_user_id
    and status not in ('stopped', 'emergency_stopped');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.pause_social_copy_subscriptions_for_billing(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.pause_social_copy_subscriptions_for_billing(uuid, uuid, text)
  to service_role;

-- 6. Gate create_social_copy_subscription -----------------------------------------------
create or replace function public.create_social_copy_subscription(
  p_source_id uuid,
  p_destination_broker_account_id uuid,
  p_sizing_mode text,
  p_fixed_lot numeric,
  p_lot_multiplier numeric,
  p_max_lot numeric,
  p_max_daily_loss numeric default null,
  p_requested_account_mode text default 'demo',
  p_symbol_map jsonb default '{}'::jsonb,
  p_manual_settings jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_source public.social_copy_sources%rowtype;
  v_source_selection record;
  v_source_mode text;
  v_destination_mode text;
  v_source_synthetic boolean := false;
  v_subscriber_synthetic boolean := false;
  v_execution_path text := 'broker';
  v_manual jsonb;
  v_id uuid;
  v_price integer;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_profile_is_eligible(v_actor) then
    raise exception 'Join the social directory before copying a trader' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.social_copy_sources s
    join public.social_profiles sp
      on sp.user_id = s.trader_user_id
    cross join lateral
      public.social_source_performance_eligibility(s.id) eligibility
    where s.id = p_source_id
      and s.status = 'published'
      and sp.is_listed = true
      and eligibility.reason = 'history_stale'
      and (
        sp.access_mode = 'open'
        or s.trader_user_id = v_actor
        or exists (
          select 1
          from public.social_follow_relationships r
          where r.follower_user_id = v_actor
            and r.followed_user_id = s.trader_user_id
            and r.status = 'accepted'
        )
      )
  ) then
    raise exception 'Provider is not eligible for copying: history_stale'
      using errcode = '55000';
  end if;

  select
    s as source,
    (s.is_synthetic = true or sp.is_synthetic_demo = true) as is_synthetic,
    coalesce(sp.monthly_copy_price_cents, 0) as monthly_copy_price_cents
  into v_source_selection
  from public.social_copy_sources s
  join public.social_profiles sp on sp.user_id = s.trader_user_id
  cross join lateral public.social_source_performance_eligibility(s.id) eligibility
  where s.id = p_source_id and s.status = 'published' and sp.is_listed = true
    and eligibility.eligible = true;
  if not found then raise exception 'Social copy source is unavailable or ineligible' using errcode = 'P0002'; end if;
  v_source := v_source_selection.source;
  v_source_synthetic := v_source_selection.is_synthetic;
  v_price := v_source_selection.monthly_copy_price_cents;
  if v_source.trader_user_id = v_actor then raise exception 'Users cannot copy themselves' using errcode = '23514'; end if;

  if coalesce(v_price, 0) > 0
     and not public.has_active_social_copy_billing(v_actor, v_source.trader_user_id) then
    raise exception 'An active paid subscription is required before copying this provider'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.broker_accounts b
    where b.id = p_destination_broker_account_id and b.user_id = v_actor
      and b.is_active = true
      and lower(coalesce(b.connection_status, '')) in ('connected', 'healthy')
      and lower(coalesce(nullif(b.provider, ''), 'fxsocket')) in ('fxsocket', 'mtapi')
      and upper(coalesce(b.platform, '')) in ('MT4', 'MT5')
  ) then
    raise exception 'Destination account is not owned, connected, or supported for Social Trading' using errcode = '42501';
  end if;

  v_source_mode := coalesce(public.social_broker_account_mode(v_source.broker_account_id), 'unknown');
  v_destination_mode := coalesce(public.social_broker_account_mode(p_destination_broker_account_id), 'unknown');
  if v_source_mode not in ('demo', 'live') or v_destination_mode not in ('demo', 'live') then
    raise exception 'Source and destination account modes must be verified' using errcode = '22023';
  end if;
  if p_requested_account_mode <> v_destination_mode then
    raise exception 'Destination account mode changed; review and confirm the selected account again' using errcode = '22023';
  end if;

  select coalesce(sp.is_synthetic_demo, false) into v_subscriber_synthetic
  from public.social_profiles sp where sp.user_id = v_actor;
  if v_source_synthetic or v_subscriber_synthetic then
    if not public.social_copy_synthetic_participants_enabled() then
      raise exception 'Synthetic Social Trading participants are disabled in this environment' using errcode = '42501';
    end if;
    v_execution_path := 'synthetic_simulation';
  end if;

  if p_sizing_mode not in ('fixed_lot', 'lot_multiplier', 'equity_ratio')
    or p_requested_account_mode not in ('demo', 'live')
    or coalesce(p_lot_multiplier, 0) <= 0 or coalesce(p_lot_multiplier, 0) > 100
    or coalesce(p_max_lot, 0) <= 0 or coalesce(p_max_lot, 0) > 1000
    or (p_sizing_mode = 'fixed_lot' and (coalesce(p_fixed_lot, 0) <= 0 or p_fixed_lot > p_max_lot))
    or (p_max_daily_loss is not null and p_max_daily_loss <= 0)
    or jsonb_typeof(coalesce(p_symbol_map, '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid social copy risk settings' using errcode = '22023';
  end if;

  v_manual := public.normalize_social_copy_manual_settings(p_manual_settings);

  insert into public.social_copy_subscriptions (
    source_id, source_trader_user_id, subscriber_user_id, destination_broker_account_id,
    sizing_mode, fixed_lot, lot_multiplier, max_lot, max_daily_loss,
    requested_account_mode, source_account_mode, destination_account_mode,
    execution_path, symbol_map, manual_settings
  ) values (
    p_source_id, v_source.trader_user_id, v_actor, p_destination_broker_account_id,
    p_sizing_mode, case when p_sizing_mode = 'fixed_lot' then p_fixed_lot else null end,
    p_lot_multiplier, p_max_lot, p_max_daily_loss,
    v_destination_mode, v_source_mode, v_destination_mode,
    v_execution_path, coalesce(p_symbol_map, '{}'::jsonb), v_manual
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A current subscription already exists for this source and destination' using errcode = '23505';
end;
$$;

revoke all on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb, jsonb)
  to authenticated;

-- 7. Paid price requires Connect charges_enabled ----------------------------------------
create or replace function public.update_provider_profile(
  p_monthly_price_cents integer, p_access_mode text, p_bio text, p_social_links jsonb
) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_links jsonb := coalesce(p_social_links, '{}'::jsonb);
  v_bio text := nullif(btrim(p_bio), '');
  v_charges_enabled boolean := false;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.social_profiles where user_id = v_actor and provider_status = 'approved'
  ) then raise exception 'Only approved providers can edit a provider profile' using errcode = '42501'; end if;
  if p_monthly_price_cents is null or p_monthly_price_cents not between 0 and 10000000 then
    raise exception 'Invalid price' using errcode = '22023';
  end if;
  if p_access_mode not in ('open', 'private') then
    raise exception 'Invalid access mode' using errcode = '22023';
  end if;
  if v_bio is not null and char_length(v_bio) > 500 then
    raise exception 'Bio is too long' using errcode = '22023';
  end if;
  if not public.social_profile_links_are_valid(v_links) then
    raise exception 'Invalid social profile links' using errcode = '22023';
  end if;

  if p_monthly_price_cents > 0 then
    select coalesce(sp.stripe_connect_charges_enabled, false)
    into v_charges_enabled
    from public.social_profiles sp
    where sp.user_id = v_actor;
    if not v_charges_enabled then
      raise exception 'Connect Stripe payouts before setting a paid copy price'
        using errcode = '55000';
    end if;
  end if;

  update public.social_profiles
  set monthly_copy_price_cents = p_monthly_price_cents, access_mode = p_access_mode, bio = v_bio
  where user_id = v_actor;
  update public.user_profiles set social_links = v_links, updated_at = now() where user_id = v_actor;
  update public.provider_applications
  set monthly_price_cents = p_monthly_price_cents, access_mode = p_access_mode,
      bio = v_bio, social_links = v_links, updated_at = now()
  where user_id = v_actor;
end;
$$;

-- 8. Client helper: billing status for a provider ---------------------------------------
create or replace function public.get_social_copy_billing_for_provider(p_provider_user_id uuid)
returns table (
  id uuid,
  status text,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  stripe_subscription_id text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  return query
  select b.id, b.status, b.current_period_end, b.cancel_at_period_end, b.stripe_subscription_id
  from public.social_copy_billing b
  where b.payer_user_id = v_actor
    and b.provider_user_id = p_provider_user_id;
end;
$$;

revoke all on function public.get_social_copy_billing_for_provider(uuid) from public, anon;
grant execute on function public.get_social_copy_billing_for_provider(uuid) to authenticated;
