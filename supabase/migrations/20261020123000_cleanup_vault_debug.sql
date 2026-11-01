-- Remove the temporary diagnostic rows created while checking the production
-- Vault service-role key. The temporary table itself was already dropped.
-- No application data is touched.

DELETE FROM supabase_migrations.schema_migrations
WHERE name LIKE 'debug_vault%';
