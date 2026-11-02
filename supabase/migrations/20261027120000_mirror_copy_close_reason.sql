-- ---------------------------------------------------------------------------
-- Mirror copy: remember why a copied trade was closed.
--
-- Mirror copies are broker-side positions; the engine never writes a `trades`
-- row for them. Without a reason on the ledger the trade detail modal could only
-- say "No close reason was recorded", even when the customer had just used
-- Close copy. The worker now stamps this column in the same UPDATE that sets
-- state='closed', so the UI can explain the close.
--
-- Values are intentionally the same vocabulary the UI already understands:
--   user_force_close     - the customer closed the copy, stopped copying, or
--                          removed the slave (the worker flattens first)
--   mirror_source_closed - the master trade closed and the copy followed it
--   position_gone        - the broker position disappeared before the engine
--                          closed it (manual close, stop loss, take profit)
-- Existing rows stay NULL; the UI shows a neutral "closed by the copier" line
-- for those instead of pretending to know.
-- ---------------------------------------------------------------------------
alter table public.mirror_copy_trade_mappings
  add column if not exists close_reason text;

comment on column public.mirror_copy_trade_mappings.close_reason is
  'Why the copier closed this copy: user_force_close, mirror_source_closed, or position_gone. NULL for rows closed before this column existed.';
