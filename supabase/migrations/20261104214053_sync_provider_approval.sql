/*
  Keep the Providers directory in sync with approved applications.

  The Social Trading Providers tab shows a trader only when
  social_profiles.provider_status = 'approved'. Approvals that only flip
  provider_applications.status (or that fail mid-way) leave the profile on
  pending with no published copy source, so the provider never appears.

  This trigger finishes approval whenever an application row is approved:
  social profile -> approved + listed, and the selected broker account is
  published as a copy source. Safe to run alongside admin_review_provider_application
  (same upserts).
*/
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

  return new;
end;
$$;

revoke all on function public.provider_applications_sync_approved() from public, anon, authenticated;

drop trigger if exists provider_applications_sync_approved on public.provider_applications;
create trigger provider_applications_sync_approved
  after insert or update of status, broker_account_id, access_mode, monthly_price_cents, bio
  on public.provider_applications
  for each row
  when (new.status = 'approved')
  execute function public.provider_applications_sync_approved();

-- Repair rows that are already approved but missing the directory state.
-- Touch a watched column so the trigger runs (updated_at alone would not).
update public.provider_applications
set access_mode = access_mode
where status = 'approved';
