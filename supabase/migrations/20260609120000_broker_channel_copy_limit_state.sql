alter table public.broker_channel_trading_configs
  add column if not exists copy_limit_state jsonb not null default '{}'::jsonb;

comment on column public.broker_channel_trading_configs.copy_limit_state is
  'Worker-managed per-channel copy limit runtime state (period snapshots, pause keys).';
