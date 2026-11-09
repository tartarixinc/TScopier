/*
  First-party live support: conversations, messages, support-agent role, realtime.
*/

-- 1. Support agent flag ------------------------------------------------------------------
alter table public.user_profiles
  add column if not exists is_support_agent boolean not null default false;

comment on column public.user_profiles.is_support_agent is
  'When true, user may access the support-admin inbox (in addition to admins via is_admin()).';

create or replace function public.is_support_agent()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (
      select (up.is_support_agent = true) or public.is_admin()
      from public.user_profiles up
      where up.user_id = auth.uid()
    ),
    false
  );
$$;

revoke all on function public.is_support_agent() from public, anon;
grant execute on function public.is_support_agent() to authenticated, service_role;

-- 2. Conversations -----------------------------------------------------------------------
create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'ai'
    check (status in ('ai', 'queued', 'active', 'resolved')),
  assignee_id uuid references auth.users(id) on delete set null,
  subject text,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_conversations_user_id_idx
  on public.support_conversations (user_id, last_message_at desc);

create index if not exists support_conversations_status_idx
  on public.support_conversations (status, last_message_at desc);

create index if not exists support_conversations_assignee_id_idx
  on public.support_conversations (assignee_id, last_message_at desc)
  where assignee_id is not null;

comment on table public.support_conversations is
  'User support threads: AI mode, queued for human, active with agent, or resolved.';

create or replace function public.touch_support_conversation_updated_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists support_conversations_touch_updated_at on public.support_conversations;
create trigger support_conversations_touch_updated_at
  before update on public.support_conversations
  for each row execute function public.touch_support_conversation_updated_at();

alter table public.support_conversations enable row level security;

drop policy if exists "Users select own support conversations" on public.support_conversations;
create policy "Users select own support conversations"
  on public.support_conversations for select to authenticated
  using (auth.uid() = user_id or public.is_support_agent());

drop policy if exists "Users insert own support conversations" on public.support_conversations;
create policy "Users insert own support conversations"
  on public.support_conversations for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users update own support conversations limited" on public.support_conversations;
create policy "Users update own support conversations limited"
  on public.support_conversations for update to authenticated
  using (auth.uid() = user_id or public.is_support_agent())
  with check (auth.uid() = user_id or public.is_support_agent());

-- 3. Messages ----------------------------------------------------------------------------
create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  sender_type text not null
    check (sender_type in ('user', 'ai', 'agent', 'system')),
  sender_user_id uuid references auth.users(id) on delete set null,
  body text not null check (char_length(btrim(body)) > 0 and char_length(body) <= 8000),
  created_at timestamptz not null default now()
);

create index if not exists support_messages_conversation_id_idx
  on public.support_messages (conversation_id, created_at);

comment on table public.support_messages is
  'Messages within a support conversation (user, AI, agent, or system).';

create or replace function public.support_messages_bump_conversation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.support_conversations
  set last_message_at = new.created_at, updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists support_messages_bump_conversation on public.support_messages;
create trigger support_messages_bump_conversation
  after insert on public.support_messages
  for each row execute function public.support_messages_bump_conversation();

alter table public.support_messages enable row level security;

drop policy if exists "Users select support messages in own threads" on public.support_messages;
create policy "Users select support messages in own threads"
  on public.support_messages for select to authenticated
  using (
    public.is_support_agent()
    or exists (
      select 1 from public.support_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

drop policy if exists "Users insert own support messages" on public.support_messages;
create policy "Users insert own support messages"
  on public.support_messages for insert to authenticated
  with check (
    (
      sender_type = 'user'
      and sender_user_id = auth.uid()
      and exists (
        select 1 from public.support_conversations c
        where c.id = conversation_id
          and c.user_id = auth.uid()
          and c.status in ('ai', 'queued', 'active')
      )
    )
    or (
      public.is_support_agent()
      and sender_type in ('agent', 'system')
    )
  );

-- 4. RPCs for agent claim / resolve / user escalate --------------------------------------
create or replace function public.support_escalate_conversation(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  update public.support_conversations
  set status = 'queued', assignee_id = null, updated_at = now()
  where id = p_conversation_id
    and user_id = v_actor
    and status in ('ai', 'queued');

  if not found then
    raise exception 'Conversation not found or cannot be escalated' using errcode = 'P0002';
  end if;

  insert into public.support_messages (conversation_id, sender_type, sender_user_id, body)
  values (
    p_conversation_id,
    'system',
    null,
    'You requested a human agent. Our support team will join shortly.'
  );
end;
$$;

revoke all on function public.support_escalate_conversation(uuid) from public, anon;
grant execute on function public.support_escalate_conversation(uuid) to authenticated;

create or replace function public.support_claim_conversation(p_conversation_id uuid)
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
  set status = 'active', assignee_id = v_actor, updated_at = now()
  where id = p_conversation_id
    and status in ('queued', 'active');

  if not found then
    raise exception 'Conversation not available to claim' using errcode = 'P0002';
  end if;

  insert into public.support_messages (conversation_id, sender_type, sender_user_id, body)
  values (
    p_conversation_id,
    'system',
    v_actor,
    'A support agent joined the conversation.'
  );
end;
$$;

revoke all on function public.support_claim_conversation(uuid) from public, anon;
grant execute on function public.support_claim_conversation(uuid) to authenticated;

create or replace function public.support_resolve_conversation(p_conversation_id uuid)
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
  set status = 'resolved', updated_at = now()
  where id = p_conversation_id;

  if not found then
    raise exception 'Conversation not found' using errcode = 'P0002';
  end if;

  insert into public.support_messages (conversation_id, sender_type, sender_user_id, body)
  values (
    p_conversation_id,
    'system',
    v_actor,
    'This conversation was marked resolved.'
  );
end;
$$;

revoke all on function public.support_resolve_conversation(uuid) from public, anon;
grant execute on function public.support_resolve_conversation(uuid) to authenticated;

-- 5. Realtime ----------------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.support_conversations;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.support_messages;
  exception when duplicate_object then null;
  end;
end $$;
