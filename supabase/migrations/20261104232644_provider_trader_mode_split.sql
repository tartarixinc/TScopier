/*
  Provider / trader role split.

  - Approved providers cannot start new outgoing copy subscriptions or paid intents.
  - On provider approval, stop the new provider's outgoing copies and reverse pending
    copy-subscription wallet ledger rows (as payer).
  - Providers can list who is copying them via get_my_provider_copiers.
*/

-- ---------------------------------------------------------------------------
-- Cancel outgoing copies + pending paid intents when a user becomes a provider
-- ---------------------------------------------------------------------------
create or replace function public.cancel_outgoing_social_copies_for_provider(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null then
    raise exception 'User is required' using errcode = '22023';
  end if;

  update public.social_copy_subscriptions
  set desired_status = 'stopped',
      updated_at = now()
  where subscriber_user_id = p_user_id
    and desired_status is distinct from 'stopped'
    and status not in ('stopped', 'emergency_stopped');

  update public.wallet_ledger
  set status = 'reversed',
      description = case
        when description ilike '%Cancelled on provider approval%' then description
        else left(coalesce(description, 'Copy subscription') || ' · Cancelled on provider approval', 240)
      end
  where payer_user_id = p_user_id
    and status = 'pending'
    and (
      description ilike 'Copy subscription%'
      or description ilike 'Copy subscription ·%'
    );
end;
$$;

revoke all on function public.cancel_outgoing_social_copies_for_provider(uuid) from public, anon, authenticated;
grant execute on function public.cancel_outgoing_social_copies_for_provider(uuid) to service_role;

comment on function public.cancel_outgoing_social_copies_for_provider(uuid) is
  'Stops outgoing social copy subscriptions and reverses pending copy-intent ledger rows when a user becomes an approved provider.';

-- Hook into the approval sync trigger so admin approve and any approved insert share one path.
create or replace function public.provider_applications_sync_approved()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_source_id uuid;
begin
  if new.status is distinct from 'approved' then
    return new;
  end if;

  insert into public.social_profiles
    (user_id, is_listed, access_mode, monthly_copy_price_cents, bio, provider_status)
  values (
    new.user_id, true, coalesce(new.access_mode, 'open'),
    new.monthly_price_cents, new.bio, 'approved'
  )
  on conflict (user_id) do update set
    is_listed = true,
    access_mode = excluded.access_mode,
    monthly_copy_price_cents = coalesce(excluded.monthly_copy_price_cents, public.social_profiles.monthly_copy_price_cents),
    bio = coalesce(excluded.bio, public.social_profiles.bio),
    provider_status = 'approved',
    updated_at = now();

  if new.broker_account_id is not null then
    insert into public.social_copy_sources (trader_user_id, broker_account_id, status)
    values (new.user_id, new.broker_account_id, 'published')
    on conflict (broker_account_id) do update set
      status = 'published',
      updated_at = now()
    where public.social_copy_sources.trader_user_id = new.user_id
    returning id into v_source_id;

    if v_source_id is not null then
      perform public.refresh_social_source_snapshots_internal(v_source_id);
    end if;
  end if;

  -- Only cancel when transitioning into approved (not on every approved-row touch).
  if tg_op = 'INSERT' or old.status is distinct from 'approved' then
    perform public.cancel_outgoing_social_copies_for_provider(new.user_id);
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Approved providers cannot become subscribers of other providers
-- ---------------------------------------------------------------------------
create or replace function public.social_copy_reject_if_subscriber_is_provider()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
    from public.social_profiles sp
    where sp.user_id = new.subscriber_user_id
      and sp.provider_status = 'approved'
  ) then
    raise exception 'Approved providers cannot copy other providers'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists social_copy_reject_if_subscriber_is_provider on public.social_copy_subscriptions;
create trigger social_copy_reject_if_subscriber_is_provider
  before insert on public.social_copy_subscriptions
  for each row
  execute function public.social_copy_reject_if_subscriber_is_provider();

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
  if exists (
    select 1 from public.social_profiles sp
    where sp.user_id = v_actor and sp.provider_status = 'approved'
  ) then
    raise exception 'Approved providers cannot copy other providers' using errcode = '55000';
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

-- ---------------------------------------------------------------------------
-- Provider-facing copier roster
-- ---------------------------------------------------------------------------
create or replace function public.get_my_provider_copiers()
returns table (
  subscription_id uuid,
  subscriber_user_id uuid,
  display_name text,
  username text,
  status text,
  desired_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.social_profiles sp
    where sp.user_id = v_actor and sp.provider_status = 'approved'
  ) then
    raise exception 'Only approved providers can view their copiers' using errcode = '42501';
  end if;

  return query
  select
    s.id,
    s.subscriber_user_id,
    coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), ''), 'Trader')::text,
    coalesce(nullif(btrim(up.username), ''), '')::text,
    s.status::text,
    s.desired_status::text,
    s.created_at
  from public.social_copy_subscriptions s
  left join public.user_profiles up on up.user_id = s.subscriber_user_id
  where s.source_trader_user_id = v_actor
    and s.desired_status is distinct from 'stopped'
    and s.status not in ('stopped', 'emergency_stopped')
  order by s.created_at desc;
end;
$$;

revoke all on function public.get_my_provider_copiers() from public, anon;
grant execute on function public.get_my_provider_copiers() to authenticated;

comment on function public.get_my_provider_copiers() is
  'Lists current copy subscriptions into the caller''s provider sources.';
