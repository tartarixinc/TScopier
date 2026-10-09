-- Let the signed-in user create and manage TradingView webhooks from the app.
-- Alert ingest still goes through the tradingview-webhook Edge Function.

grant select, insert, update, delete on public.tradingview_webhooks to authenticated;
grant select on public.tradingview_webhook_deliveries to authenticated;

drop policy if exists "Users can insert own tradingview webhooks"
  on public.tradingview_webhooks;
create policy "Users can insert own tradingview webhooks"
  on public.tradingview_webhooks for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own tradingview webhooks"
  on public.tradingview_webhooks;
create policy "Users can update own tradingview webhooks"
  on public.tradingview_webhooks for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own tradingview webhooks"
  on public.tradingview_webhooks;
create policy "Users can delete own tradingview webhooks"
  on public.tradingview_webhooks for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own tradingview channels"
  on public.telegram_channels;
create policy "Users can insert own tradingview channels"
  on public.telegram_channels for insert
  to authenticated
  with check (auth.uid() = user_id and source_kind = 'tradingview');
