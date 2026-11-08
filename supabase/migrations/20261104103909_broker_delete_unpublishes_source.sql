/*
  Deleting a broker account that is a published provider source.

  social_copy_sources.broker_account_id is ON DELETE RESTRICT, so a provider could never delete
  the account they had published: the delete failed and the optimistic UI put the account back
  ("it keeps coming back"). Deleting the account now also retires its own copy-source row, unless
  somebody is copying it, in which case the delete is refused with a plain-language reason.
  provider_applications.broker_account_id already clears itself (ON DELETE SET NULL).
*/
create or replace function public.broker_accounts_unpublish_source_before_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
    from public.social_copy_sources s
    join public.social_copy_subscriptions sub on sub.source_id = s.id
    where s.broker_account_id = old.id
  ) then
    raise exception 'Other traders are copying this provider account, so it can’t be deleted yet. Stop their copying first, then delete it.'
      using errcode = '23503';
  end if;

  delete from public.social_copy_sources where broker_account_id = old.id;
  return old;
end;
$$;

revoke all on function public.broker_accounts_unpublish_source_before_delete() from public, anon, authenticated;

drop trigger if exists broker_accounts_unpublish_source_before_delete on public.broker_accounts;
create trigger broker_accounts_unpublish_source_before_delete
  before delete on public.broker_accounts
  for each row execute function public.broker_accounts_unpublish_source_before_delete();
