-- Durable idempotency + dead-letter storage for Redis Streams signal queue.

create table if not exists public.signal_queue_idempotency (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  signal_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  lane text not null,
  created_at timestamptz not null default now()
);

create index if not exists signal_queue_idempotency_signal_idx
  on public.signal_queue_idempotency (signal_id);

create index if not exists signal_queue_idempotency_user_created_idx
  on public.signal_queue_idempotency (user_id, created_at desc);

create table if not exists public.signal_queue_dead_letters (
  id uuid primary key default gen_random_uuid(),
  stream_key text not null,
  message_id text not null,
  idempotency_key text not null,
  signal_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  lane text not null,
  shard_id integer not null default 0,
  attempts integer not null default 1,
  reason text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'dead',
  replayed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists signal_queue_dead_letters_user_created_idx
  on public.signal_queue_dead_letters (user_id, created_at desc);

create index if not exists signal_queue_dead_letters_status_created_idx
  on public.signal_queue_dead_letters (status, created_at desc);

alter table public.signal_queue_idempotency enable row level security;
alter table public.signal_queue_dead_letters enable row level security;

-- Service role only (worker writes); no client policies.
