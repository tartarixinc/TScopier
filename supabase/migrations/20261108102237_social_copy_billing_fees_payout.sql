/*
  Platform fee percentages + provider TRC20 payout method.
  Also: list payer's social copy billings with provider identity for Billing UI.
*/

-- 1. Singleton fee settings -------------------------------------------------------------
create table if not exists public.platform_fee_settings (
  id smallint primary key default 1 check (id = 1),
  provider_fee_percent numeric(5, 2) not null default 0
    check (provider_fee_percent >= 0 and provider_fee_percent <= 100),
  copier_fee_percent numeric(5, 2) not null default 0
    check (copier_fee_percent >= 0 and copier_fee_percent <= 100),
  payout_fee_percent numeric(5, 2) not null default 0
    check (payout_fee_percent >= 0 and payout_fee_percent <= 100),
  updated_at timestamptz not null default now()
);

comment on table public.platform_fee_settings is
  'Singleton platform fee rates: provider (taken from provider earnings), copier (added to copy price), payout (taken when withdrawing).';

insert into public.platform_fee_settings (id)
values (1)
on conflict (id) do nothing;

alter table public.platform_fee_settings enable row level security;

drop policy if exists "Authenticated can read platform fee settings" on public.platform_fee_settings;
create policy "Authenticated can read platform fee settings"
  on public.platform_fee_settings
  for select
  to authenticated
  using (true);

-- Service role updates fees (admin / SQL); no client write policy.

create or replace function public.get_platform_fee_settings()
returns table (
  provider_fee_percent numeric,
  copier_fee_percent numeric,
  payout_fee_percent numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.provider_fee_percent, s.copier_fee_percent, s.payout_fee_percent
  from public.platform_fee_settings s
  where s.id = 1;
$$;

revoke all on function public.get_platform_fee_settings() from public, anon;
grant execute on function public.get_platform_fee_settings() to authenticated, service_role;

-- 2. Provider payout method (TRC20 USDT / USDC) ------------------------------------------
alter table public.user_wallets
  add column if not exists payout_asset text,
  add column if not exists payout_network text,
  add column if not exists payout_address text,
  add column if not exists payout_updated_at timestamptz;

alter table public.user_wallets drop constraint if exists user_wallets_payout_asset_check;
alter table public.user_wallets
  add constraint user_wallets_payout_asset_check
  check (payout_asset is null or payout_asset in ('USDT', 'USDC'));

alter table public.user_wallets drop constraint if exists user_wallets_payout_network_check;
alter table public.user_wallets
  add constraint user_wallets_payout_network_check
  check (payout_network is null or payout_network = 'TRC20');

alter table public.user_wallets drop constraint if exists user_wallets_payout_complete_check;
alter table public.user_wallets
  add constraint user_wallets_payout_complete_check
  check (
    (payout_asset is null and payout_network is null and payout_address is null)
    or (
      payout_asset is not null
      and payout_network = 'TRC20'
      and payout_address is not null
      and char_length(payout_address) between 30 and 64
    )
  );

create or replace function public.update_my_wallet_payout_method(
  p_asset text,
  p_address text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_asset text := upper(nullif(btrim(p_asset), ''));
  v_address text := nullif(btrim(p_address), '');
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if v_asset is null or v_address is null then
    raise exception 'Payout asset and address are required' using errcode = '22023';
  end if;
  if v_asset not in ('USDT', 'USDC') then
    raise exception 'Payout asset must be USDT or USDC' using errcode = '22023';
  end if;
  -- Tron base58 address (TRC20)
  if v_address !~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' then
    raise exception 'Enter a valid TRC20 wallet address' using errcode = '22023';
  end if;

  insert into public.user_wallets (user_id)
  values (v_actor)
  on conflict (user_id) do nothing;

  update public.user_wallets
  set
    payout_asset = v_asset,
    payout_network = 'TRC20',
    payout_address = v_address,
    payout_updated_at = now()
  where user_id = v_actor;
end;
$$;

revoke all on function public.update_my_wallet_payout_method(text, text) from public, anon;
grant execute on function public.update_my_wallet_payout_method(text, text) to authenticated;

create or replace function public.clear_my_wallet_payout_method()
returns void
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
  update public.user_wallets
  set
    payout_asset = null,
    payout_network = null,
    payout_address = null,
    payout_updated_at = now()
  where user_id = v_actor;
end;
$$;

revoke all on function public.clear_my_wallet_payout_method() from public, anon;
grant execute on function public.clear_my_wallet_payout_method() to authenticated;

-- 3. List my provider copy billings (Billing page) --------------------------------------
create or replace function public.get_my_social_copy_billing()
returns table (
  id uuid,
  provider_user_id uuid,
  provider_display_name text,
  provider_username text,
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
  select
    b.id,
    b.provider_user_id,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), ''), 'Provider') as provider_display_name,
    coalesce(up.username, '') as provider_username,
    b.status,
    b.current_period_end,
    b.cancel_at_period_end,
    b.stripe_subscription_id
  from public.social_copy_billing b
  left join public.user_profiles up on up.user_id = b.provider_user_id
  where b.payer_user_id = v_actor
  order by b.updated_at desc;
end;
$$;

revoke all on function public.get_my_social_copy_billing() from public, anon;
grant execute on function public.get_my_social_copy_billing() to authenticated;
