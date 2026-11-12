-- BEFORE DELETE triggers must use OLD (NEW is null). Returning NEW aborted every
-- broker_copy_links delete, so Mirror Accounts "Delete" cleared the UI but the
-- row survived and reappeared on refresh.

create or replace function public.mirror_copy_block_delete_with_open_copies()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  open_count integer;
begin
  select count(*) into open_count
  from public.mirror_copy_trade_mappings
  where link_id = old.id
    and state in ('opening', 'open', 'closing', 'uncertain', 'error');
  if open_count > 0 then
    raise exception 'MIRROR_OPEN_COPIES: Remove blocked: % copied trade(s) are still open on the slave account. Stop copying on the Mirror Account page first (that closes them), then remove the link.', open_count
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;
