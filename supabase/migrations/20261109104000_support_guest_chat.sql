-- Guest (unsigned) support chat: name + email + opaque guest_token.

alter table public.support_conversations
  alter column user_id drop not null;

alter table public.support_conversations
  add column if not exists guest_name text,
  add column if not exists guest_email text,
  add column if not exists guest_token uuid;

update public.support_conversations
set guest_token = gen_random_uuid()
where guest_token is null and user_id is null;

alter table public.support_conversations
  drop constraint if exists support_conversations_owner_check;

alter table public.support_conversations
  add constraint support_conversations_owner_check
  check (
    user_id is not null
    or (
      guest_email is not null
      and char_length(btrim(guest_email)) > 3
      and guest_name is not null
      and char_length(btrim(guest_name)) > 0
      and guest_token is not null
    )
  );

create unique index if not exists support_conversations_guest_token_uidx
  on public.support_conversations (guest_token)
  where guest_token is not null;

create index if not exists support_conversations_guest_email_idx
  on public.support_conversations (lower(guest_email), last_message_at desc)
  where guest_email is not null;

comment on column public.support_conversations.guest_token is
  'Opaque token for guest clients to resume a conversation without signing in.';
