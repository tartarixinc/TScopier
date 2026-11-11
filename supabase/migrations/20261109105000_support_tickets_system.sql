-- Support tickets (separate from live chat) + messages for Resend round-trip.

create sequence if not exists public.support_tickets_number_seq;

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  number integer not null default nextval('public.support_tickets_number_seq'),
  user_id uuid references auth.users(id) on delete set null,
  guest_name text,
  guest_email text,
  guest_token uuid,
  subject text not null check (char_length(btrim(subject)) > 0 and char_length(subject) <= 200),
  status text not null default 'open'
    check (status in ('open', 'pending', 'resolved', 'closed')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid references auth.users(id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_tickets_owner_check check (
    user_id is not null
    or (
      guest_email is not null
      and char_length(btrim(guest_email)) > 3
      and guest_name is not null
      and char_length(btrim(guest_name)) > 0
      and guest_token is not null
    )
  )
);

alter sequence public.support_tickets_number_seq owned by public.support_tickets.number;

create unique index if not exists support_tickets_number_uidx
  on public.support_tickets (number);

create index if not exists support_tickets_user_id_idx
  on public.support_tickets (user_id, last_message_at desc)
  where user_id is not null;

create index if not exists support_tickets_status_idx
  on public.support_tickets (status, last_message_at desc);

create index if not exists support_tickets_assignee_id_idx
  on public.support_tickets (assignee_id, last_message_at desc)
  where assignee_id is not null;

create unique index if not exists support_tickets_guest_token_uidx
  on public.support_tickets (guest_token)
  where guest_token is not null;

create index if not exists support_tickets_guest_email_idx
  on public.support_tickets (lower(guest_email), last_message_at desc)
  where guest_email is not null;

comment on table public.support_tickets is
  'Email/support tickets separate from live chat; guests identified by guest_token.';

create or replace function public.touch_support_ticket_updated_at()
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

drop trigger if exists support_tickets_touch_updated_at on public.support_tickets;
create trigger support_tickets_touch_updated_at
  before update on public.support_tickets
  for each row execute function public.touch_support_ticket_updated_at();

alter table public.support_tickets enable row level security;

drop policy if exists "Users select own support tickets" on public.support_tickets;
create policy "Users select own support tickets"
  on public.support_tickets for select to authenticated
  using (auth.uid() = user_id or public.is_support_agent());

drop policy if exists "Users insert own support tickets" on public.support_tickets;
create policy "Users insert own support tickets"
  on public.support_tickets for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users update own support tickets limited" on public.support_tickets;
create policy "Users update own support tickets limited"
  on public.support_tickets for update to authenticated
  using (auth.uid() = user_id or public.is_support_agent())
  with check (auth.uid() = user_id or public.is_support_agent());

-- Messages -------------------------------------------------------------------------------
create table if not exists public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  sender_type text not null
    check (sender_type in ('user', 'agent', 'system', 'email_inbound')),
  sender_user_id uuid references auth.users(id) on delete set null,
  body text not null check (char_length(btrim(body)) > 0 and char_length(body) <= 20000),
  images text[] not null default '{}',
  resend_id text,
  email_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists support_ticket_messages_ticket_id_idx
  on public.support_ticket_messages (ticket_id, created_at);

create index if not exists support_ticket_messages_email_message_id_idx
  on public.support_ticket_messages (email_message_id)
  where email_message_id is not null;

comment on table public.support_ticket_messages is
  'Ticket thread messages including outbound Resend and inbound email replies.';

create or replace function public.support_ticket_messages_bump_ticket()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.support_tickets
  set last_message_at = new.created_at, updated_at = now()
  where id = new.ticket_id;
  return new;
end;
$$;

drop trigger if exists support_ticket_messages_bump_ticket on public.support_ticket_messages;
create trigger support_ticket_messages_bump_ticket
  after insert on public.support_ticket_messages
  for each row execute function public.support_ticket_messages_bump_ticket();

alter table public.support_ticket_messages enable row level security;

drop policy if exists "Users select support ticket messages" on public.support_ticket_messages;
create policy "Users select support ticket messages"
  on public.support_ticket_messages for select to authenticated
  using (
    public.is_support_agent()
    or exists (
      select 1 from public.support_tickets t
      where t.id = ticket_id and t.user_id = auth.uid()
    )
  );

drop policy if exists "Users insert own support ticket messages" on public.support_ticket_messages;
create policy "Users insert own support ticket messages"
  on public.support_ticket_messages for insert to authenticated
  with check (
    (
      sender_type = 'user'
      and sender_user_id = auth.uid()
      and exists (
        select 1 from public.support_tickets t
        where t.id = ticket_id
          and t.user_id = auth.uid()
          and t.status in ('open', 'pending')
      )
    )
    or (
      public.is_support_agent()
      and sender_type in ('agent', 'system')
    )
  );

-- Agent RPCs -----------------------------------------------------------------------------
create or replace function public.support_claim_ticket(p_ticket_id uuid)
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

  update public.support_tickets
  set status = case when status in ('resolved', 'closed') then 'open' else status end,
      assignee_id = v_actor,
      updated_at = now()
  where id = p_ticket_id;

  if not found then
    raise exception 'Ticket not found' using errcode = 'P0002';
  end if;

  insert into public.support_ticket_messages (ticket_id, sender_type, sender_user_id, body)
  values (p_ticket_id, 'system', v_actor, 'A support agent claimed this ticket.');
end;
$$;

revoke all on function public.support_claim_ticket(uuid) from public, anon;
grant execute on function public.support_claim_ticket(uuid) to authenticated;

create or replace function public.support_resolve_ticket(p_ticket_id uuid)
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

  update public.support_tickets
  set status = 'resolved', updated_at = now()
  where id = p_ticket_id;

  if not found then
    raise exception 'Ticket not found' using errcode = 'P0002';
  end if;

  insert into public.support_ticket_messages (ticket_id, sender_type, sender_user_id, body)
  values (p_ticket_id, 'system', v_actor, 'This ticket was marked resolved.');
end;
$$;

revoke all on function public.support_resolve_ticket(uuid) from public, anon;
grant execute on function public.support_resolve_ticket(uuid) to authenticated;

-- Realtime -------------------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.support_tickets;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.support_ticket_messages;
  exception when duplicate_object then null;
  end;
end $$;
