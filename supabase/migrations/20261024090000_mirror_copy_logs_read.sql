-- Mirror trading: let the owning user read copy execution events, so the
-- /copier-logs page can show mirror activity beside signal activity.
--
-- Both tables were created by 20261018170000_mirror_copy_engine.sql with row
-- security enabled and no user-facing SELECT policy, so until now only the
-- service role could read them. This adds read-only, owner-scoped access.
-- Nothing here writes or alters data, and the worker (service role) is
-- unaffected because service_role bypasses row security.

grant select on table mirror_copy_execution_events to authenticated;
grant select on table mirror_copy_trade_mappings to authenticated;

drop policy if exists "Users can view own mirror copy execution events" on mirror_copy_execution_events;
create policy "Users can view own mirror copy execution events"
  on mirror_copy_execution_events
  for select
  using (exists (
    select 1
      from broker_copy_links l
     where l.id = mirror_copy_execution_events.link_id
       and l.user_id = auth.uid()
  ));

drop policy if exists "Users can view own mirror copy trade mappings" on mirror_copy_trade_mappings;
create policy "Users can view own mirror copy trade mappings"
  on mirror_copy_trade_mappings
  for select
  using (exists (
    select 1
      from broker_copy_links l
     where l.id = mirror_copy_trade_mappings.link_id
       and l.user_id = auth.uid()
  ));
