-- Mirror copy: let the owning user request a close of one copied trade.
--
-- The engine already has every piece needed to close a single copy: the ledger
-- state 'closing' (in the CHECK constraint since day one, and already treated as
-- "still ours to manage" by the delete guard), and the worker's closeMapping
-- path (event claim, re-read before send, uncertain retry). What was missing was
-- any way for a human to ask. This RPC is the ask: it records intent on the
-- mapping, and the worker honours it on its next reconcile tick (~20s), exactly
-- like set_mirror_copy_link_status records intent for start/pause/stop.
--
-- Deliberate choices:
--  * Only mappings in ('open', 'uncertain', 'error', 'closing') are accepted.
--    'opening' is excluded: the broker open may still be in flight and the
--    worker's finalizeOpen would overwrite the request, making it silently lost.
--    'closing' is accepted so a timed-out request can simply be retried.
--  * Once the worker sets 'closed', the unique key (link_id, source_ticket)
--    makes the engine's re-open attempt a silent no-op — a close stays closed
--    for the life of that master trade; no code path can duplicate the order.
--  * Any previous close event for the same source ticket that can no longer
--    advance is reset so this request can actually run again: status 'uncertain'
--    (retries exhausted — e.g. after a weekend "market is closed" rejection), or
--    status 'claimed' by a worker that then crashed and never completed it (the
--    staleness bound — 2 minutes — is safely beyond the worker's own stale-claim
--    lease of at least 60s, so a live in-flight claim is never clobbered). Without this a wedged close would be a
--    permanent dead-end no matter how often the user pressed the button.
-- ---------------------------------------------------------------------------
create or replace function public.request_mirror_copy_close(p_mapping_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_link_id uuid;
  v_source_ticket text;
  v_updated integer;
begin
  select m.link_id, m.source_ticket
    into v_link_id, v_source_ticket
  from public.mirror_copy_trade_mappings m
  where m.id = p_mapping_id
    and exists (
      select 1 from public.broker_copy_links l
      where l.id = m.link_id
        and (l.user_id = auth.uid() or auth.role() = 'service_role')
    );

  if v_link_id is null then
    -- Uniform refusal (same as set_mirror_copy_link_status): a missing mapping
    -- and a foreign mapping answer identically, so the response leaks nothing
    -- about which mapping ids exist.
    raise exception 'not authorized for this mirror copy' using errcode = '42501';
  end if;

  update public.mirror_copy_trade_mappings
     set state = 'closing'
   where id = p_mapping_id
     and state in ('open', 'uncertain', 'error', 'closing');
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;
  end if;

  update public.mirror_copy_execution_events
     set status = 'failed',
         attempt_count = 1,
         completed_at = null,
         error_code = null,
         error_detail = null
   where link_id = v_link_id
     and idempotency_key = 'close:' || v_source_ticket
     and (status = 'uncertain'
          or (status = 'claimed' and updated_at < now() - interval '2 minutes'));

  return true;
end;
$$;

comment on function public.request_mirror_copy_close(uuid) is
  'Owner-scoped: marks one mirror-copy mapping as closing; the worker executes the close on its next reconcile tick.';

revoke all on function public.request_mirror_copy_close(uuid) from public, anon;
grant execute on function public.request_mirror_copy_close(uuid) to authenticated, service_role;
