-- Repair trade ↔ channel linkage so management close can find open legs.
-- Safe to re-run. Run in Supabase SQL Editor, then review verification at bottom.

begin;

-- 1. Backfill trades.telegram_channel_id from signals.channel_id
update public.trades t
set telegram_channel_id = s.channel_id
from public.signals s
where t.signal_id = s.id
  and t.telegram_channel_id is null
  and s.channel_id is not null;

-- 2. Refresh trade_channel_attributions for open/pending legs (trigger may have missed rows)
insert into public.trade_channel_attributions (
  trade_id,
  user_id,
  broker_account_id,
  metaapi_order_id,
  signal_id,
  channel_id,
  channel_label
)
select
  t.id,
  t.user_id,
  t.broker_account_id,
  t.metaapi_order_id,
  t.signal_id,
  coalesce(t.telegram_channel_id, s.channel_id),
  coalesce(
    nullif(trim(c.display_name), ''),
    nullif(trim(c.channel_username), ''),
    'Unlinked / manual'
  )
from public.trades t
left join public.signals s on s.id = t.signal_id
left join public.telegram_channels c on c.id = coalesce(t.telegram_channel_id, s.channel_id)
where t.status in ('open', 'pending')
  and coalesce(t.telegram_channel_id, s.channel_id) is not null
on conflict (trade_id) do update set
  user_id = excluded.user_id,
  broker_account_id = excluded.broker_account_id,
  metaapi_order_id = excluded.metaapi_order_id,
  signal_id = excluded.signal_id,
  channel_id = excluded.channel_id,
  channel_label = excluded.channel_label,
  updated_at = now();

commit;

-- Verification: open/pending trades missing channel linkage
select
  t.id,
  t.broker_account_id,
  t.metaapi_order_id,
  t.symbol,
  t.status,
  t.telegram_channel_id,
  t.signal_id,
  s.channel_id as signal_channel_id,
  a.channel_id as attribution_channel_id
from public.trades t
left join public.signals s on s.id = t.signal_id
left join public.trade_channel_attributions a on a.trade_id = t.id
where t.status in ('open', 'pending')
  and coalesce(t.telegram_channel_id, s.channel_id, a.channel_id) is null
order by t.opened_at desc nulls last
limit 50;
