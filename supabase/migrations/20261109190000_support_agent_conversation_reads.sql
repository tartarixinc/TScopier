-- Per-agent last-opened timestamps for support inbox "New" badges.

create table if not exists public.support_agent_conversation_reads (
  agent_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (agent_user_id, conversation_id)
);

create index if not exists support_agent_conversation_reads_conversation_idx
  on public.support_agent_conversation_reads (conversation_id);

comment on table public.support_agent_conversation_reads is
  'Per-agent last-opened timestamps for support inbox New badges.';

alter table public.support_agent_conversation_reads enable row level security;

drop policy if exists "Agents manage own conversation reads" on public.support_agent_conversation_reads;
create policy "Agents manage own conversation reads"
  on public.support_agent_conversation_reads
  for all
  to authenticated
  using (auth.uid() = agent_user_id and public.is_support_agent())
  with check (auth.uid() = agent_user_id and public.is_support_agent());

create or replace function public.support_mark_conversation_read(p_conversation_id uuid)
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

  insert into public.support_agent_conversation_reads (agent_user_id, conversation_id, last_read_at)
  values (v_actor, p_conversation_id, now())
  on conflict (agent_user_id, conversation_id)
  do update set last_read_at = greatest(
    public.support_agent_conversation_reads.last_read_at,
    excluded.last_read_at
  );
end;
$$;

revoke all on function public.support_mark_conversation_read(uuid) from public, anon;
grant execute on function public.support_mark_conversation_read(uuid) to authenticated;
