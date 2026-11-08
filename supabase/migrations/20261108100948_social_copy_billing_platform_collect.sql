/*
  Platform collects copy fees on TScopier's Stripe account.
  Providers do not need Stripe Connect to publish a paid price.
  Earnings continue to settle into wallet_ledger / user_wallets.pending_cents.
*/

create or replace function public.update_provider_profile(
  p_monthly_price_cents integer, p_access_mode text, p_bio text, p_social_links jsonb
) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_links jsonb := coalesce(p_social_links, '{}'::jsonb);
  v_bio text := nullif(btrim(p_bio), '');
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
