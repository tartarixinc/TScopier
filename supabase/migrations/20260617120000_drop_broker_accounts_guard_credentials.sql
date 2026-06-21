-- FxSocket migration dropped credential columns but left the guard trigger,
-- which still references mt_password_encrypted and breaks broker inserts.

DROP TRIGGER IF EXISTS broker_accounts_guard_credentials ON public.broker_accounts;

DROP FUNCTION IF EXISTS public.broker_accounts_guard_credentials();
