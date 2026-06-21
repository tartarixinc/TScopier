-- Ensure authenticated clients can read/write broker_channel_trading_configs (RLS still applies).
grant select, insert, update, delete on public.broker_channel_trading_configs to authenticated;
