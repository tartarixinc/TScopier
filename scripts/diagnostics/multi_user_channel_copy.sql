-- Multi-user channel copy diagnostics (run in Supabase SQL Editor after a test signal).
-- See docs/worker-deployment.md and multi-user channel copy plan.

-- 1) Sessions and leases (each user needs active session + valid lease)
select s.user_id, s.is_active as tg_session_active, l.worker_id, l.role, l.expires_at,
       l.expires_at > now() as lease_valid
from telegram_sessions s
left join worker_session_leases l on l.user_id = s.user_id
order by s.user_id;

-- 2) Channel rows per user (each user has their own telegram_channels.id UUID)
select user_id, id as channel_row_id, channel_id as tg_chat_id, channel_username, display_name, is_active
from telegram_channels
where is_active = true
order by user_id, display_name;

-- 3) Broker ↔ channel linkage (signal_channel_ids must contain that user's channel_row_id)
select b.user_id, b.id as broker_id, b.label, b.is_active,
       b.signal_channel_ids, b.enforce_signal_channel_filter
from broker_accounts b
where b.is_active
order by b.user_id, b.label;

-- 4) Recent signals (did each user ingest the same Telegram post?)
select user_id, id, status, skip_reason, channel_id, created_at, left(raw_message, 80) as preview
from signals
where created_at > now() - interval '2 hours'
order by created_at desc;

-- 5) Channel Worker feed (trade_execution_logs)
select l.user_id, l.created_at, l.action, l.status, l.error_message, l.signal_id
from trade_execution_logs l
where l.created_at > now() - interval '2 hours'
order by l.created_at desc
limit 50;

-- 6) Users with active channels but NO broker linked to any channel (common misconfiguration)
select tc.user_id, tc.id as channel_row_id, tc.display_name,
       count(b.id) filter (where tc.id = any(b.signal_channel_ids)) as linked_brokers
from telegram_channels tc
left join broker_accounts b on b.user_id = tc.user_id and b.is_active
where tc.is_active
group by tc.user_id, tc.id, tc.display_name
having count(b.id) filter (where tc.id = any(b.signal_channel_ids)) = 0;

-- 7) Active channels with invalid Telegram identity (listener cannot map messages)
-- channel_id must be numeric OR channel_username must be set; display_name alone is not enough.
select user_id, id as channel_row_id, display_name, channel_id as tg_chat_id,
       channel_username, is_active, last_seen_at,
       case
         when coalesce(nullif(trim(channel_username), ''), '') <> '' then false
         when channel_id ~ '^-?[0-9]+$' then false
         else true
       end as invalid_identity
from telegram_channels
where is_active
  and (
    coalesce(nullif(trim(channel_username), ''), '') = ''
  )
order by user_id, display_name;

-- 8) Listener audit events (poll errors, unmapped channels — last 2 hours)
select user_id, channel_row_id, event_type, telegram_message_id, detail, created_at
from listener_events
where created_at > now() - interval '2 hours'
order by created_at desc
limit 100;

-- 9) Parse funnel by channel (last 2 hours) — where ingest stops
select tc.display_name,
       tc.id as channel_row_id,
       s.status,
       s.skip_reason,
       count(*) as n
from signals s
join telegram_channels tc on tc.id = s.channel_id
where s.created_at > now() - interval '2 hours'
group by 1, 2, 3, 4
order by 1, 3, 4;

-- 10) Latest signal row per channel (24h) — did ANY message persist?
select distinct on (s.channel_id)
  tc.display_name,
  tc.id as channel_row_id,
  s.status,
  s.skip_reason,
  left(s.raw_message, 80) as preview,
  s.created_at
from signals s
join telegram_channels tc on tc.id = s.channel_id
where s.created_at > now() - interval '24 hours'
order by s.channel_id, s.created_at desc;

-- 11) Per-channel parse context (keywords + lexicon for replay / diff)
select tc.user_id,
       tc.display_name,
       tc.id as channel_row_id,
       tc.channel_keywords,
       l.action_aliases,
       l.tp_aliases,
       l.target_aliases
from telegram_channels tc
left join channel_signal_lexicon l on l.channel_id = tc.id
where tc.is_active
order by tc.user_id, tc.display_name;

-- 12) Parse-stage listener events (heuristic reject, duplicate skip — last 2 hours)
select user_id, channel_row_id, event_type, telegram_message_id, detail, created_at
from listener_events
where created_at > now() - interval '2 hours'
  and event_type in (
    'heuristic_rejected',
    'duplicate_message_skipped',
    'parse_http_failed',
    'image_only_message',
    'signal_persist_failed',
    'channel_row_ambiguous',
    'unmapped_channel',
    'poll_peer_resolve_failed',
    'poll_error'
  )
order by created_at desc
limit 100;

-- 13) Cross-channel Telegram message id collisions (symptom of old user_id+msg unique index)
-- Same numeric message id stored for different channels should be normal after migration
-- 20260525160000; before the fix only one channel could own each id.
select s.telegram_message_id,
       count(distinct s.channel_id) as channels,
       array_agg(distinct tc.display_name order by tc.display_name) as channel_names,
       max(s.created_at) as latest_at
from signals s
join telegram_channels tc on tc.id = s.channel_id
where s.telegram_message_id is not null
  and s.created_at > now() - interval '24 hours'
group by s.telegram_message_id
having count(distinct s.channel_id) > 1
order by latest_at desc
limit 50;

-- 14) Per-channel ingest health (find channels with live activity but no signals)
select tc.display_name,
       tc.id as channel_row_id,
       tc.channel_id as tg_chat_id,
       tc.channel_username,
       tc.last_live_at,
       tc.last_seen_at,
       ls.last_signal_at,
       ls.last_status,
       ls.last_skip_reason,
       coalesce(ev.events_2h, 0) as listener_events_2h
from telegram_channels tc
left join lateral (
  select s.created_at as last_signal_at,
         s.status as last_status,
         s.skip_reason as last_skip_reason
  from signals s
  where s.channel_id = tc.id
  order by s.created_at desc
  limit 1
) ls on true
left join lateral (
  select count(*)::int as events_2h
  from listener_events le
  where le.channel_row_id = tc.id
    and le.created_at > now() - interval '2 hours'
) ev on true
where tc.is_active
order by tc.display_name;

-- 15) Duplicate active channel rows (same display name or same tg chat id)
select user_id,
       lower(trim(display_name)) as title,
       count(*) as row_count,
       array_agg(id::text order by coalesce(last_seen_at, created_at) desc nulls last) as channel_row_ids,
       array_agg(channel_id order by coalesce(last_seen_at, created_at) desc nulls last) as tg_chat_ids,
       array_agg(coalesce(last_seen_at::text, 'never') order by coalesce(last_seen_at, created_at) desc nulls last) as last_seen
from telegram_channels
where is_active
group by user_id, lower(trim(display_name))
having count(*) > 1
order by row_count desc;
