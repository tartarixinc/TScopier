/*
  # TScopier - schedule range-pending-sweep edge function

  Runs the `range-pending-sweep` Edge Function every minute as a backup to the
  worker's virtualPendingMonitor (1.5s tick). The edge function only touches
  rows the worker has likely missed (untouched for 45s+), so the two pollers
  do not duplicate work — the CAS update on `range_pending_legs.status` makes
  the race deterministic regardless.

  Prerequisites (one-time, Supabase Dashboard → Database → Extensions):
    1. Enable the `pg_cron` extension.
    2. Enable the `pg_net` extension.

  Also one-time, run as the Supabase project owner:
    ALTER DATABASE postgres SET app.settings.supabase_url     = 'https://<project>.supabase.co';
    ALTER DATABASE postgres SET app.settings.service_role_key = '<service_role_key>';

  Without those settings the cron job will fail silently. Test by calling
    SELECT cron.run_job(<jobid>);
  or by hitting the URL directly with `curl` once.
*/

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace any previous schedule (idempotent re-runs).
do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'range-pending-sweep';
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end $$;

select cron.schedule(
  'range-pending-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := current_setting('app.settings.supabase_url', true) || '/functions/v1/range-pending-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);
