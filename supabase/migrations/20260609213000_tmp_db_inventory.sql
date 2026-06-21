/*
  Temporary introspection helper for the database-cleanup audit.
  Dropped again by the follow-up cleanup migration.
*/

create or replace function public.tmp_db_inventory()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  cron_jobs jsonb := '[]'::jsonb;
begin
  begin
    execute 'select coalesce(jsonb_agg(jsonb_build_object(''jobname'', jobname, ''schedule'', schedule, ''command'', command)), ''[]''::jsonb) from cron.job'
      into cron_jobs;
  exception when others then
    cron_jobs := '[]'::jsonb;
  end;

  select jsonb_build_object(
    'functions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', p.proname,
        'kind', p.prokind,
        'rettype', pg_get_function_result(p.oid),
        'args', pg_get_function_identity_arguments(p.oid),
        'src', left(p.prosrc, 8000)
      ) order by p.proname), '[]'::jsonb)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
    ),
    'triggers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'table', c.relname,
        'name', t.tgname,
        'func', pf.proname
      ) order by c.relname, t.tgname), '[]'::jsonb)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc pf on pf.oid = t.tgfoid
      where n.nspname = 'public' and not t.tgisinternal
    ),
    'views', (
      select coalesce(jsonb_agg(viewname order by viewname), '[]'::jsonb)
      from pg_views where schemaname = 'public'
    ),
    'cron_jobs', cron_jobs
  ) into result;

  return result;
end;
$$;

revoke all on function public.tmp_db_inventory() from public;
revoke all on function public.tmp_db_inventory() from anon;
revoke all on function public.tmp_db_inventory() from authenticated;
grant execute on function public.tmp_db_inventory() to service_role;
