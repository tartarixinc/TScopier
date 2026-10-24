-- Admin audit triggers — record direct (non-edge-function) admin writes.
--
-- Context (2026-10-23 review): `admin_audit_logs` had 0 rows and 0
-- `admin-mutate` calls in 29 days. Only the `admin-mutate` edge function
-- routes through `writeAdminAudit`; every other admin/ops write goes straight
-- to the tables (backoffice PostgREST, Supabase Management API, psql) and is
-- invisible to the audit trail.
--
-- These triggers close that gap at the database itself: any INSERT/UPDATE/
-- DELETE on the audited tables that carries a human actor (a JWT `sub`, or the
-- `app.admin_actor` session setting used by psql/Management-API sessions) is
-- recorded.
--
-- DESIGN NOTES (revised after review)
--   * Invoker detection: the trigger function is SECURITY DEFINER, so
--     `current_user` inside it is the FUNCTION OWNER and can never identify
--     the writer. `session_user` is the real login instead:
--         'authenticator' -> a PostgREST request (edge functions, backoffice,
--                            worker via service_role);
--         'postgres'      -> psql / Management API (exactly what we must catch).
--     A PostgREST write is recorded only when a human actor is present
--     (JWT sub or `app.admin_actor`); bare service-role traffic (the worker
--     updating broker status thousands of times a day) is skipped.
--   * Entity id: tables do not share a primary key (`user_profiles.user_id`,
--     `alert_rules.code`, everything else `id`), so the id is read from the
--     row JSON with fallbacks — never `NEW.id`, which raises on those two.
--   * Row contents are NOT copied: only the set of changed column names is
--     stored. Audit rows must never become a second copy of customer data or
--     credentials (trades, broker_accounts.password, etc.).
--   * For psql / Management API sessions there is no JWT, so declare the actor
--     first (session scope, `false`):
--         SELECT set_config('app.admin_actor', '<admin-user-uuid>', false);
--     Without it the row is still written (that is the point of this
--     migration) with `reason = 'no human actor in session'` and the
--     `session_user` recorded in the payload.
--   * `admin_audit_logs` itself is excluded from triggering (it already has
--     immutability triggers), so there is no recursion.
--
-- PREPARED, NOT APPLIED: this migration is provided for manual execution with
-- a write-capable token (the reviewing agent's token is read-only). Review,
-- adjust the table list if needed, apply on STAGING FIRST and smoke-test
-- (one write per table, one audit row each), then apply to production.

-- Trigger rows may have no resolvable actor (psql, Management API) — those
-- writes are exactly what this migration exists to catch, so the column must
-- accept NULL and the payload records `session_user` instead. Edge-function
-- rows (writeAdminAudit) always carry an actor.
ALTER TABLE public.admin_audit_logs
  ALTER COLUMN actor_user_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.admin_audit_log_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jwt_sub text := NULLIF(current_setting('request.jwt.claim.sub', true), '');
  jwt_role text := NULLIF(current_setting('request.jwt.claim.role', true), '');
  guc_actor text := NULLIF(current_setting('app.admin_actor', true), '');
  actor_id uuid;
  invoker text := session_user;   -- NOT current_user: SECURITY DEFINER makes that the owner
  op text := TG_OP;
  row_json jsonb;
  entity_id text;
  changed_keys text[] := ARRAY[]::text[];
  old_json jsonb;
  new_json jsonb;
BEGIN
  -- PostgREST request with no human actor: worker/system traffic
  -- (service_role or anon without a sub) — not an admin action.
  IF invoker = 'authenticator' AND jwt_sub IS NULL AND guc_actor IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    actor_id := COALESCE(jwt_sub, guc_actor)::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    actor_id := NULL;
  END;

  row_json := to_jsonb(COALESCE(NEW, OLD));
  -- Primary keys differ per table: id (most), user_id (user_profiles), code
  -- (alert_rules). A raised "record has no field" would be swallowed by the
  -- outer handler and silently drop the audit row, so the access is by JSON key.
  entity_id := COALESCE(row_json ->> 'id', row_json ->> 'user_id', row_json ->> 'code');

  IF TG_OP = 'INSERT' THEN
    changed_keys := ARRAY(SELECT jsonb_object_keys(to_jsonb(NEW)));
  ELSIF TG_OP = 'UPDATE' THEN
    old_json := to_jsonb(OLD);
    new_json := to_jsonb(NEW);
    changed_keys := ARRAY(
      SELECT key FROM jsonb_object_keys(new_json) AS key
      WHERE old_json -> key IS DISTINCT FROM new_json -> key
    );
    -- Nothing changed: an UPDATE that only touched a trigger-managed column is
    -- not an admin action worth an audit row.
    IF cardinality(changed_keys) = 0 THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.admin_audit_logs (
    actor_user_id,
    target_user_id,
    action,
    entity_type,
    entity_id,
    reason,
    request_payload
  ) VALUES (
    -- The human actor (JWT sub or app.admin_actor GUC). NULL for bare psql /
    -- Management-API writes with no declared actor — the payload carries
    -- `session_user` so the writer is still identifiable.
    actor_id,
    (row_json ->> 'user_id')::uuid,
    lower(op) || '_' || TG_TABLE_NAME,
    TG_TABLE_NAME,
    entity_id,
    CASE WHEN actor_id IS NULL THEN 'no human actor in session' ELSE NULL END,
    jsonb_build_object(
      'session_user', invoker,
      'jwt_role', jwt_role,
      'jwt_sub', jwt_sub,
      'admin_actor_guc', guc_actor,
      'changed_keys', to_jsonb(changed_keys)
    )
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- An audit failure must never block the underlying write; log to stderr for
  -- the Postgres log instead.
  RAISE WARNING 'admin_audit_log_trigger failed on % %: %', TG_TABLE_NAME, TG_OP, SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_audit_log_trigger() FROM PUBLIC;
-- EXECUTE is required for the trigger to fire for the writing role. The
-- SECURITY DEFINER body limits what that privilege can do: it only ever
-- inserts into admin_audit_logs.
GRANT EXECUTE ON FUNCTION public.admin_audit_log_trigger() TO postgres, service_role, anon, authenticated;
-- Add these too if the backoffice or dashboard ever connects as them:
-- GRANT EXECUTE ON FUNCTION public.admin_audit_log_trigger() TO supabase_admin, dashboard_user;

-- Audited tables: customer identity and billing, broker/channel config, alert
-- config. Worker-hot tables (trades, signals) are intentionally NOT listed —
-- service-role writes are skipped anyway, but keeping the list config-scoped
-- keeps the intent obvious.
DO $$
DECLARE
  t text;
  tables CONSTANT text[] := ARRAY[
    'user_profiles',
    'subscriptions',
    'broker_accounts',
    'telegram_channels',
    'alert_rules',
    'alert_recipients'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skipping audit trigger for missing table %', t;
      CONTINUE;
    END IF;
    EXECUTE format(
      'DROP TRIGGER IF EXISTS admin_audit_%1$s ON public.%1$s', t);
    EXECUTE format(
      'CREATE TRIGGER admin_audit_%1$s '
      'AFTER INSERT OR UPDATE OR DELETE ON public.%1$s '
      'FOR EACH ROW EXECUTE FUNCTION public.admin_audit_log_trigger()', t);
  END LOOP;
END $$;

COMMENT ON FUNCTION public.admin_audit_log_trigger() IS
  'AFTER trigger: records human-actor writes (JWT sub or app.admin_actor GUC) into admin_audit_logs. Invoker detection uses session_user (SECURITY DEFINER makes current_user the owner). Worker (authenticator + no sub) traffic is skipped; row contents are never copied — only changed column names.';
