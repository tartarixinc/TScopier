/*
  Self-service: close an approved provider profile.

  Removes the caller from the Providers directory, retires their published copy
  sources, pauses active copy subscriptions, and resets the application to draft
  so they can apply again later. Distinct from admin suspend (which keeps the
  profile as a suspended provider and can be reinstated).
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

  update public.provider_applications
  set status = 'draft',
      reviewed_by = null,
      reviewed_at = null,
      rejection_reason = null,
      updated_at = now()
  where user_id = v_actor;

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
    v_before,
    (select to_jsonb(pa) - 'social_links' from public.provider_applications pa where pa.user_id = v_actor)
  );
end;
$$;

revoke all on function public.close_provider_profile() from public, anon;
grant execute on function public.close_provider_profile() to authenticated;

comment on function public.close_provider_profile() is
  'Approved provider closes their own profile: leaves the directory, retires copy sources, resets the application to draft.';
