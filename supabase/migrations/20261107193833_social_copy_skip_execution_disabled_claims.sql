-- Stop disabled Railway replicas from repeatedly claiming and erroring
-- subscriptions with EXECUTION_DISABLED. Migration preview reconciliation is
-- handled by the social-copy-reconcile Edge Function instead.

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
      -- Leave EXECUTION_DISABLED rows for an execution-capable worker / edge reconciler.
      and not (s.status = 'error' and s.error_code = 'EXECUTION_DISABLED')
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

-- Clear poisoned worker-disable errors and pin the lease to the edge reconciler
-- so a disabled Railway replica cannot reclaim them first.
update public.social_copy_subscriptions
set
  status = 'pending',
  error_code = null,
  error_detail = null,
  lease_owner = 'social-copy-edge',
  lease_expires_at = now() + interval '2 hours',
  worker_acknowledged_at = null,
  last_reconciled_at = null,
  updated_at = now()
where status = 'error'
  and error_code in ('EXECUTION_DISABLED', 'SOCIAL_ACCESS_REVOKED', 'BROKER_DISCONNECTED', 'SOURCE_DISCONNECTED')
  and desired_status = 'active';

-- Cron: invoke Migration social-copy-reconcile every minute.
DO $$ DECLARE v_jobid bigint; BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'social-copy-reconcile';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule('social-copy-reconcile', '* * * * *', $cmd$
DO $body$
DECLARE
  v_url text;
  v_key text;
BEGIN
  v_url := nullif(trim(coalesce(current_setting('app.settings.supabase_url', true), '')), '');
  v_key := nullif(trim(coalesce(current_setting('app.settings.service_role_key', true), '')), '');

  IF v_url IS NULL AND to_regclass('public.app_secrets') IS NOT NULL THEN
    BEGIN
      SELECT nullif(trim(value), '') INTO v_url FROM public.app_secrets WHERE key = 'supabase_url';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  IF v_key IS NULL AND to_regclass('public.app_secrets') IS NOT NULL THEN
    BEGIN
      SELECT nullif(trim(value), '') INTO v_key FROM public.app_secrets WHERE key = 'service_role_key';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  IF v_url IS NULL OR v_url NOT LIKE '%.supabase.co%' THEN
    BEGIN
      SELECT nullif(trim(decrypted_secret), '') INTO v_url
      FROM vault.decrypted_secrets
      WHERE name = 'supabase_url' AND decrypted_secret LIKE '%.supabase.co%'
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  IF v_key IS NULL THEN
    BEGIN
      SELECT nullif(trim(decrypted_secret), '') INTO v_key
      FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE NOTICE 'Skipping social-copy-reconcile: missing supabase URL or service_role_key';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/social-copy-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
END
$body$;
$cmd$);
