-- Persist TradingView alert JSON builder choices per webhook.

alter table public.tradingview_webhooks
  add column if not exists alert_config jsonb;

comment on column public.tradingview_webhooks.alert_config is
  'UI alert JSON builder: { kind, includeSl, includeTp, tpCount, symbol? }. Does not affect ingest.';
