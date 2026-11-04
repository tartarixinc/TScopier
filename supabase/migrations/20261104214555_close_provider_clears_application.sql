/*
  Closing a provider profile must not leave a draft application behind.

  Resetting to draft made the Social Trading CTA say "Continue your application".
  Delete the application after the audit row is written so the CTA is
  "Become a provider" again; they can start a new application from scratch.
*/
create or replace function public.close_provider_profile()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_before jsonb;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  select to_jsonb(pa) - 'social_links' into v_before
  from public.provider_applications pa
  where pa.user_id = v_actor
  for update;
  if not found then
    raise exception 'Provider application was not found' using errcode = 'P0002';
  end if;
  if (v_before ->> 'status') <> 'approved' then
    raise exception 'Only an approved provider can close their profile' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.social_profiles
    where user_id = v_actor and provider_status = 'approved'
  ) then
    raise exception 'Only an approved provider can close their profile' using errcode = '55000';
  end if;

  update public.social_profiles
  set provider_status = 'none',
      updated_at = now()
  where user_id = v_actor;

  update public.social_copy_sources
  set status = 'retired', updated_at = now()
  where trader_user_id = v_actor and status in ('published', 'paused');

  update public.social_copy_subscriptions sub
  set desired_status = 'paused', updated_at = now()
  where sub.source_id in (select id from public.social_copy_sources where trader_user_id = v_actor)
    and sub.status not in ('stopped', 'emergency_stopped')
    and sub.desired_status <> 'stopped';

  perform public.provider_audit(
    v_actor, 'provider_application.close', 'Closed by provider',
    v_before, null
  );

  delete from public.provider_applications where user_id = v_actor;
end;
$$;

comment on function public.close_provider_profile() is
  'Approved provider closes their own profile: leaves the directory, retires copy sources, and deletes the application so they can apply again from scratch.';

-- Clear draft leftovers from the earlier close behaviour (profile already not a provider).
delete from public.provider_applications pa
using public.social_profiles sp
where pa.user_id = sp.user_id
  and pa.status = 'draft'
  and sp.provider_status = 'none';
