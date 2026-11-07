-- Make the alert-evaluator cron work in both projects.
--
-- Staging stores its URL and service-role key in public.app_secrets; production
-- stores them in Supabase Vault (vault.decrypted_secrets). The previous job
-- command read only `current_setting('app.settings.*')`, which is set in
-- neither project, so production's job returned early every minute and the
-- evaluator never ran. This command tries all three sources in order and
-- keeps the existing one-minute schedule.

DO $$ DECLARE v_jobid bigint; BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'alert-evaluator';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule('alert-evaluator', '* * * * *', $cmd$
DO $body$
DECLARE
  v_url text;
  v_key text;
BEGIN
  v_url := nullif(trim(coalesce(current_setting('app.settings.supabase_url', true), '')), '');
  v_key := nullif(trim(coalesce(current_setting('app.settings.service_role_key', true), '')), '');

  IF v_url IS NULL AND to_regclass('public.app_secrets') IS NOT NULL THEN
    BEGIN
      SELECT nullif(trim(value), '') INTO v_url
      FROM public.app_secrets WHERE key = 'supabase_url';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  IF v_key IS NULL AND to_regclass('public.app_secrets') IS NOT NULL THEN
    BEGIN
      SELECT nullif(trim(value), '') INTO v_key
      FROM public.app_secrets WHERE key = 'service_role_key';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  IF v_url IS NULL OR v_url NOT LIKE '%.supabase.co%' THEN
    BEGIN
      SELECT nullif(trim(decrypted_secret), '') INTO v_url
      FROM vault.decrypted_secrets
      WHERE name = 'supabase_url'
        AND decrypted_secret LIKE '%.supabase.co%'
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  IF v_key IS NULL THEN
    BEGIN
      SELECT nullif(trim(decrypted_secret), '') INTO v_key
      FROM vault.decrypted_secrets
      WHERE name = 'service_role_key'
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE NOTICE 'Skipping alert-evaluator: missing supabase URL or service_role_key (app.settings / app_secrets / vault)';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/alert-evaluator',
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
