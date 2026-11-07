/*
  Paid-provider copy intent (UI paywall gate).

  When a subscriber confirms "Subscribe for $X/Month" in the Copy preview modal,
  record a pending wallet_ledger row. No charge yet — Stripe/wallet debit comes later.
  Idempotent for an open pending row for the same payer + provider.
*/
create or replace function public.subscribe_social_copy_intent(p_provider_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_price integer;
  v_name text;
  v_existing uuid;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_provider_user_id is null then
    raise exception 'Provider is required' using errcode = '22023';
  end if;
  if p_provider_user_id = v_actor then
    raise exception 'You cannot subscribe to your own provider profile' using errcode = '23514';
  end if;

  select sp.monthly_copy_price_cents,
         coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), ''), 'Provider')
  into v_price, v_name
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  where sp.user_id = p_provider_user_id
    and sp.is_listed = true
    and sp.provider_status = 'approved';
  if not found then
    raise exception 'Provider profile is not available' using errcode = 'P0002';
  end if;
  if v_price is null or v_price <= 0 then
    raise exception 'This provider is free to copy' using errcode = '55000';
  end if;

  select wl.id into v_existing
  from public.wallet_ledger wl
  where wl.payer_user_id = v_actor
    and wl.provider_user_id = p_provider_user_id
    and wl.status = 'pending'
  order by wl.created_at desc
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.user_wallets (user_id)
  values (v_actor)
  on conflict (user_id) do nothing;

  insert into public.wallet_ledger
    (payer_user_id, provider_user_id, amount_cents, currency, status, description)
  values (
    v_actor,
    p_provider_user_id,
    v_price,
    'usd',
    'pending',
    'Copy subscription · ' || left(v_name, 80)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.subscribe_social_copy_intent(uuid) from public, anon;
grant execute on function public.subscribe_social_copy_intent(uuid) to authenticated;

comment on function public.subscribe_social_copy_intent(uuid) is
  'Records a pending wallet ledger row when a user accepts a paid provider copy subscription in the UI. No charge yet.';
