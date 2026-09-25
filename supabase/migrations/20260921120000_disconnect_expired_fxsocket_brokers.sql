ALTER TABLE public.broker_accounts ADD COLUMN IF NOT EXISTS disconnect_reason text, ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;
COMMENT ON COLUMN public.broker_accounts.disconnect_reason IS 'Auditable local disconnect reason; subscription_expired_grace_elapsed is set by scheduled FXSocket cleanup.';
CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pg_net;
DO $$ DECLARE v_jobid bigint; BEGIN SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'disconnect-expired-fxsocket-brokers'; IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF; END $$;
SELECT cron.schedule('disconnect-expired-fxsocket-brokers', '25 2 * * *', $cmd$
DO $$ DECLARE v_url text := current_setting('app.settings.supabase_url', true); v_key text := current_setting('app.settings.service_role_key', true); BEGIN
IF v_url IS NULL OR v_key IS NULL OR length(trim(v_url)) = 0 OR length(trim(v_key)) = 0 THEN RAISE NOTICE 'Skipping disconnect-expired-fxsocket-brokers: missing app settings'; RETURN; END IF;
PERFORM net.http_post(url := v_url || '/functions/v1/disconnect-expired-fxsocket-brokers', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key), body := '{}'::jsonb, timeout_milliseconds := 55000); END $$;
$cmd$);
