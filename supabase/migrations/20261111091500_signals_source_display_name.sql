-- Keep the human source name on signals after telegram_channels is deleted.

alter table public.signals
  add column if not exists source_display_name text;

comment on column public.signals.source_display_name is
  'Channel/webhook display name at ingest time. Survives channel delete for Copier Logs.';

-- Backfill from live channel rows.
update public.signals s
set source_display_name = coalesce(
  nullif(trim(tc.display_name), ''),
  case
    when nullif(trim(tc.channel_username), '') is not null
      then '@' || ltrim(trim(tc.channel_username), '@')
    else null
  end
)
from public.telegram_channels tc
where s.channel_id = tc.id
  and (s.source_display_name is null or trim(s.source_display_name) = '');

-- Orphans: fall back to the platform label so Copier Logs never show a bare dash.
update public.signals
set source_display_name = case source_kind
  when 'tradingview' then 'TradingView'
  when 'discord' then 'Discord'
  when 'whatsapp' then 'WhatsApp'
  else 'Telegram'
end
where channel_id is null
  and (source_display_name is null or trim(source_display_name) = '');

create or replace function public.signals_stamp_source_kind_on_channel_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  stamped_name text;
begin
  stamped_name := coalesce(
    nullif(trim(old.display_name), ''),
    case
      when nullif(trim(old.channel_username), '') is not null
        then '@' || ltrim(trim(old.channel_username), '@')
      else null
    end,
    case coalesce(nullif(old.source_kind, ''), 'telegram')
      when 'tradingview' then 'TradingView'
      when 'discord' then 'Discord'
      when 'whatsapp' then 'WhatsApp'
      else 'Telegram'
    end
  );

  update public.signals
  set
    source_kind = coalesce(nullif(source_kind, ''), nullif(old.source_kind, ''), 'telegram'),
    source_display_name = coalesce(nullif(trim(source_display_name), ''), stamped_name)
  where channel_id = old.id;

  return old;
end;
$$;
