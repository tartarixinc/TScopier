-- Restore broker-path social copy claims for execution-capable workers.
-- The edge-only gate blocked Railway/Migration workers from running
-- syncPosition/closeMapping, so provider closes and SL/TP changes never copied.
-- Keep skipping EXECUTION_DISABLED so disabled replicas cannot reclaim and poison
-- subscriptions. Edge reconciler (worker id social-copy-edge) can still claim.

create or replace function public.claim_social_copy_subscriptions(
  p_worker text,
  p_limit integer default 20,
  p_lease_seconds integer default 30
) returns setof social_copy_subscriptions
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  return query
  with candidates as (
    select s.id from public.social_copy_subscriptions s
    where s.status not in ('stopped', 'emergency_stopped')
      -- Leave EXECUTION_DISABLED for an execution-capable worker / edge reconciler.
      and not (
        s.status = 'error'
        and s.error_code = 'EXECUTION_DISABLED'
        and p_worker is distinct from 'social-copy-edge'
      )
      and (s.lease_expires_at is null or s.lease_expires_at < now() or s.lease_owner = p_worker)
    order by coalesce(s.last_reconciled_at, s.created_at), s.id
    for update skip locked limit greatest(1, least(p_limit, 100))
  )
  update public.social_copy_subscriptions s set
    lease_owner = p_worker,
    lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300)))
  from candidates c where s.id = c.id returning s.*;
end;
$$;

revoke all on function public.claim_social_copy_subscriptions(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_social_copy_subscriptions(text, integer, integer)
  to service_role;

-- Clear long edge-pinned leases so workers can take over immediately.
update public.social_copy_subscriptions
set
  lease_owner = null,
  lease_expires_at = null,
  updated_at = now()
where lease_owner = 'social-copy-edge'
  and desired_status = 'active';
