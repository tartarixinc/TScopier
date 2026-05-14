/*
  # range_pending_legs — purge legacy terminal rows

  Worker (`virtualPendingMonitor`) and edge `range-pending-sweep` now DELETE
  rows when they expire (TTL) or after a successful market fire, instead of
  leaving `status = 'expired'` / `'fired'` tombstones.

  This migration removes any existing rows in those terminal states so the
  table matches the new behavior immediately after deploy.
*/

delete from public.range_pending_legs
where status in ('fired', 'expired');
