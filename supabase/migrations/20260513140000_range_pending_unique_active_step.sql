/*
  At most one active (pending or claimed) virtual leg per ladder rung:
  (signal_id, broker_account_id, symbol, step_idx).

  Prevents duplicate INSERTs from ever creating two competing rows for the same
  step — which could otherwise both pass the shallow-step gate or race in CAS.

  Companion migration (apply if not already on the project):
  `20260513120000_cancel_range_pending_on_trade_close.sql` — cancels virtual
  pendings when the last trade for the basket closes.

  If this migration fails with a unique violation, clean duplicates first, e.g.:

    select signal_id, broker_account_id, symbol, step_idx, status, count(*)
    from public.range_pending_legs
    where status in ('pending', 'claimed')
    group by 1,2,3,4,5
    having count(*) > 1;

    -- For each duplicate set, keep one row (lowest id) and cancel or delete the rest:
    update public.range_pending_legs r
    set status = 'cancelled', error_message = 'duplicate_active_step_cleanup'
    where id in ( ... ids to drop ... );
*/

create unique index if not exists range_pending_legs_active_step_unique
  on public.range_pending_legs (signal_id, broker_account_id, symbol, step_idx)
  where status in ('pending', 'claimed');

comment on index public.range_pending_legs_active_step_unique is
  'Ensures at most one pending/claimed virtual leg per (signal, broker, symbol, step_idx).';
