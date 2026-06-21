/*
  # TScopier - schedule basket-sl-tp-sweep edge function

  Backup to worker BasketSlTpReconcileMonitor (15s). Edge only claims jobs
  untouched for 45s+ so the two pollers do not fight.
*/

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'basket-sl-tp-sweep';
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end $$;

select cron.schedule(
  'basket-sl-tp-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := current_setting('app.settings.supabase_url', true) || '/functions/v1/basket-sl-tp-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);
