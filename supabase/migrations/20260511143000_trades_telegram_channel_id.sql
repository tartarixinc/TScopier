alter table public.trades
  add column if not exists telegram_channel_id uuid references public.telegram_channels(id) on delete set null;

create index if not exists trades_telegram_channel_id_idx
  on public.trades(telegram_channel_id);

update public.trades t
set telegram_channel_id = s.channel_id
from public.signals s
where t.signal_id = s.id
  and t.telegram_channel_id is null
  and s.channel_id is not null;
