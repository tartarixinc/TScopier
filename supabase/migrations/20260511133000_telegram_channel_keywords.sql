alter table public.telegram_channels
  add column if not exists channel_keywords jsonb not null default '{}'::jsonb;

comment on column public.telegram_channels.channel_keywords is
  'Per-channel parsing keywords (signal/update/additional) used to match channel-specific vocabulary.';
