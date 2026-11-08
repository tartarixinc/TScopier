-- Until Railway has SOCIAL_COPY_EXECUTION_ENABLED, only the Migration edge
-- reconciler may claim broker-path social copy subscriptions.

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
      and not (s.status = 'error' and s.error_code = 'EXECUTION_DISABLED' and p_worker is distinct from 'social-copy-edge')
      -- Broker execution on Migration preview is owned by social-copy-reconcile.
      and (s.execution_path = 'synthetic_simulation' or p_worker = 'social-copy-edge')
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

-- If a disabled replica already flipped an active broker sub back to
-- EXECUTION_DISABLED, restore it for the edge reconciler.
update public.social_copy_subscriptions
set
  status = 'pending',
  error_code = null,
  error_detail = null,
  lease_owner = 'social-copy-edge',
  lease_expires_at = now() + interval '2 hours',
  updated_at = now()
where execution_path = 'broker'
  and desired_status = 'active'
  and status = 'error'
  and error_code = 'EXECUTION_DISABLED';
