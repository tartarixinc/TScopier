-- Allow support agents to reassign live chats to another agent.

create or replace function public.support_reassign_conversation(
  p_conversation_id uuid,
  p_assignee_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_assignee_name text;
  v_ok boolean;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.is_support_agent() then
    raise exception 'Support agent access required' using errcode = '42501';
  end if;
  if p_assignee_id is null then
    raise exception 'Assignee required' using errcode = '22023';
  end if;

  select exists (
    select 1
    from public.user_profiles up
    where up.user_id = p_assignee_id
      and (up.is_support_agent = true or up.is_admin = true)
  ) into v_ok;

  if not v_ok then
    raise exception 'Assignee must be a support agent' using errcode = '42501';
  end if;

  update public.support_conversations
  set status = 'active',
      assignee_id = p_assignee_id,
      updated_at = now()
  where id = p_conversation_id
    and status in ('queued', 'active');

  if not found then
    raise exception 'Conversation not available to reassign' using errcode = 'P0002';
  end if;

  v_actor_name := coalesce(public.support_agent_display_name(v_actor), 'A support agent');
  v_assignee_name := coalesce(public.support_agent_display_name(p_assignee_id), 'a support agent');

  insert into public.support_messages (conversation_id, sender_type, sender_user_id, body)
  values (
    p_conversation_id,
    'system',
    v_actor,
    v_actor_name || ' reassigned the chat to ' || v_assignee_name || '.'
  );
end;
$$;

revoke all on function public.support_reassign_conversation(uuid, uuid) from public, anon;
grant execute on function public.support_reassign_conversation(uuid, uuid) to authenticated;
