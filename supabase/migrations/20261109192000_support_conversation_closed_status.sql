-- Add closed status for archived support chats + close RPC.

alter table public.support_conversations
  drop constraint if exists support_conversations_status_check;

alter table public.support_conversations
  add constraint support_conversations_status_check
  check (status in ('ai', 'queued', 'active', 'resolved', 'closed'));

create or replace function public.support_close_conversation(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.is_support_agent() then
    raise exception 'Support agent access required' using errcode = '42501';
  end if;

  update public.support_conversations
  set status = 'closed', updated_at = now()
  where id = p_conversation_id
    and status in ('queued', 'active', 'resolved');

  if not found then
    raise exception 'Conversation not available to close' using errcode = 'P0002';
  end if;

  insert into public.support_messages (conversation_id, sender_type, sender_user_id, body)
  values (
    p_conversation_id,
    'system',
    v_actor,
    'This conversation was closed.'
  );
end;
$$;

revoke all on function public.support_close_conversation(uuid) from public, anon;
grant execute on function public.support_close_conversation(uuid) to authenticated;
