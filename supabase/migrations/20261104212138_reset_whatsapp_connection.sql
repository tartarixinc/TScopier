/*
  Disconnecting WhatsApp while the listener is down.

  whatsapp_auth (the saved WhatsApp login) and whatsapp_sessions.status are only writable by the
  listener, so with the listener stopped "Disconnect" failed and the page kept showing the account
  as connected. This lets a signed-in user clear their own saved login and mark the session
  disconnected without the listener.
*/
create or replace function public.reset_whatsapp_connection()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  delete from public.whatsapp_auth where user_id = v_actor;
  update public.whatsapp_sessions
  set status = 'disconnected', updated_at = now()
  where user_id = v_actor;
end;
$$;

revoke all on function public.reset_whatsapp_connection() from public, anon;
grant execute on function public.reset_whatsapp_connection() to authenticated;
