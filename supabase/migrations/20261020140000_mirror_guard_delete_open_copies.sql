-- ---------------------------------------------------------------------------
-- Mirror copy: refuse to delete a copy link while copied trades are still open.
--
-- Removing a link hard-deletes its ledger through the cascade. If copied trades
-- on the slave are still open at the broker, that would erase the only record of
-- them and leave live positions unmanaged. The dashboard now stops a link first
-- (the worker flattens the copies, then the delete succeeds); this trigger
-- protects every other path -- drag-to-disconnect on the Configurations page,
-- account-removal cascades, scripts -- from doing the damage.
--
-- The MIRROR_OPEN_COPIES marker lets the frontend recognise the refusal and show
-- a clean message (and run the stop-then-retry flow) instead of the raw text.
--
-- 'closing' is included for completeness even though the worker never writes it
-- today (its closeAll only sweeps opening/open/uncertain/error); blocking on it
-- is fail-safe should a future code path use that state.
-- ---------------------------------------------------------------------------
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
  where link_id = new.id
    and state in ('opening', 'open', 'closing', 'uncertain', 'error');
  if open_count > 0 then
    raise exception 'MIRROR_OPEN_COPIES: Remove blocked: % copied trade(s) are still open on the slave account. Stop copying on the Mirror Account page first (that closes them), then remove the link.', open_count
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.mirror_copy_block_delete_with_open_copies() from public, anon, authenticated;

drop trigger if exists mirror_copy_block_delete_with_open_copies on public.broker_copy_links;
create trigger mirror_copy_block_delete_with_open_copies
  before delete on public.broker_copy_links
  for each row execute function public.mirror_copy_block_delete_with_open_copies();
