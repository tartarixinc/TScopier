-- Denormalize signal source kind onto signals so Copier Logs keep the
-- platform logo after telegram_channels rows are deleted (channel_id SET NULL).

alter table public.signals
  add column if not exists source_kind text;

alter table public.signals
  drop constraint if exists signals_source_kind_check;

alter table public.signals
  add constraint signals_source_kind_check
  check (
    source_kind is null
    or source_kind in ('telegram', 'tradingview', 'discord', 'whatsapp')
  );

comment on column public.signals.source_kind is
  'Platform that produced the signal (telegram/tradingview/discord/whatsapp). Survives channel delete.';

-- Backfill from live channel rows.
update public.signals s
set source_kind = coalesce(nullif(tc.source_kind, ''), 'telegram')
from public.telegram_channels tc
where s.channel_id = tc.id
  and (s.source_kind is null or s.source_kind = '');

-- Orphan TradingView rows that already lost channel_id.
update public.signals
set source_kind = 'tradingview'
where channel_id is null
  and source_kind is null
  and lower(coalesce(parsed_data->>'signal_source', '')) = 'tradingview';

-- Remaining orphans with a Telegram message id were almost always Telegram.
update public.signals
set source_kind = 'telegram'
where channel_id is null
  and source_kind is null
  and telegram_message_id is not null
  and coalesce(parsed_data->>'signal_source', '') = '';

-- Stamp source_kind before ON DELETE SET NULL clears channel_id.
create or replace function public.signals_stamp_source_kind_on_channel_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.signals
  set source_kind = coalesce(nullif(old.source_kind, ''), 'telegram')
  where channel_id = old.id
    and (source_kind is null or source_kind = '');
  return old;
end;
$$;

drop trigger if exists signals_stamp_source_kind_on_channel_delete on public.telegram_channels;

create trigger signals_stamp_source_kind_on_channel_delete
  before delete on public.telegram_channels
  for each row
  execute function public.signals_stamp_source_kind_on_channel_delete();
