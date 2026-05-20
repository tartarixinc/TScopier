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
