-- Named join messages + public agent profile snippets for support widget avatars.

create or replace function public.support_agent_display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    nullif(trim(both from concat_ws(' ', up.first_name, up.last_name)), ''),
    nullif(trim(up.display_name), ''),
    'A support agent'
  )
  from public.user_profiles up
  where up.user_id = p_user_id;
$$;

revoke all on function public.support_agent_display_name(uuid) from public, anon;
grant execute on function public.support_agent_display_name(uuid) to authenticated, service_role;

create or replace function public.support_claim_conversation(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_name text;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.is_support_agent() then
    raise exception 'Support agent access required' using errcode = '42501';
  end if;

  update public.support_conversations
  set status = 'active', assignee_id = v_actor, updated_at = now()
  where id = p_conversation_id
    and status in ('queued', 'active');

  if not found then
    raise exception 'Conversation not available to claim' using errcode = 'P0002';
  end if;

  v_name := coalesce(public.support_agent_display_name(v_actor), 'A support agent');

  insert into public.support_messages (conversation_id, sender_type, sender_user_id, body)
  values (
    p_conversation_id,
    'system',
    v_actor,
    v_name || ' Joined the Chat.'
  );
end;
$$;

revoke all on function public.support_claim_conversation(uuid) from public, anon;
grant execute on function public.support_claim_conversation(uuid) to authenticated;

-- Safe public snippets for support-team faces (name + avatar only).
create or replace function public.support_public_agent_profiles(p_user_ids uuid[] default null)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    up.user_id,
    coalesce(
      nullif(trim(both from concat_ws(' ', up.first_name, up.last_name)), ''),
      nullif(trim(up.display_name), ''),
      'Support'
    ) as display_name,
    up.avatar_url
  from public.user_profiles up
  where (up.is_support_agent = true or up.is_admin = true)
    and (
      p_user_ids is null
      or cardinality(p_user_ids) = 0
      or up.user_id = any (p_user_ids)
    )
  order by up.updated_at desc nulls last
  limit 24;
$$;

revoke all on function public.support_public_agent_profiles(uuid[]) from public;
grant execute on function public.support_public_agent_profiles(uuid[]) to anon, authenticated, service_role;
