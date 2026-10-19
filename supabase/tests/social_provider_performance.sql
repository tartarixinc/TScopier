begin;

select plan(39);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data)
values
  ('40000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'provider@example.test', '', now(), '{"providers":["email"]}'),
  ('40000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'viewer@example.test', '', now(), '{"providers":["email"]}'),
  ('40000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'upstream@example.test', '', now(), '{"providers":["email"]}');

update public.user_profiles set
  display_name = case user_id
    when '40000000-0000-0000-0000-000000000001' then 'Provider'
    when '40000000-0000-0000-0000-000000000002' then 'Viewer'
    else 'Upstream' end,
  username = case user_id
    when '40000000-0000-0000-0000-000000000001' then 'provider'
    when '40000000-0000-0000-0000-000000000002' then 'viewer'
    else 'upstream' end,
  email_verified_at = now()
where user_id::text like '40000000-%';

insert into public.subscriptions (id, user_id, stripe_customer_id, plan, status)
values
  ('40500000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'cus_socialperformance_provider_001', 'advanced', 'active'),
  ('40500000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'cus_socialperformance_viewer_002', 'basic', 'active'),
  ('40500000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 'cus_socialperformance_upstream_003', 'basic', 'active');

insert into public.broker_accounts (
  id, user_id, label, platform, metaapi_account_id, provider, is_active,
  connection_status, linked_account_type, last_synced_at, last_currency
) values
  ('41000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Published A', 'MT5', 'provider-a', 'fxsocket', true, 'connected', 'Demo', now(), 'USD'),
  ('41000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'Unrelated B', 'MT5', 'provider-b', 'fxsocket', true, 'connected', 'Demo', now(), 'USD'),
  ('41000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000002', 'Viewer destination', 'MT5', 'viewer-dst', 'fxsocket', true, 'connected', 'Demo', now(), 'USD'),
  ('41000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000003', 'Upstream source', 'MT5', 'upstream-src', 'fxsocket', true, 'connected', 'Demo', now(), 'USD'),
  ('41000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000001', 'Empty live account', 'MT5', 'provider-empty', 'fxsocket', true, 'connected', 'Live', now(), 'USD');

insert into public.trades (
  user_id, broker_account_id, metaapi_order_id, symbol, direction,
  status, opened_at, closed_at, profit, created_at
)
select
  '40000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000001',
  'eligible-' || n,
  'EURUSD', case when n % 2 = 0 then 'buy' else 'sell' end,
  'closed', now() - make_interval(days => n),
  now() - make_interval(days => n) + interval '1 hour',
  case when n % 3 = 0 then -5 else 10 end,
  '2026-01-02T00:00:00Z'::timestamptz + make_interval(secs => n)
from generate_series(1, 10) n;

insert into public.trades (
  user_id, broker_account_id, metaapi_order_id, symbol, direction,
  status, opened_at, profit
) values (
  '40000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000001',
  'open-1', 'USDJPY', 'buy', 'open', now() - interval '2 hours', null
);

-- Historical duplicate: pre-cutoff rows are not covered by the later unique
-- index, so the social query must collapse this ticket itself.
insert into public.trades (
  user_id, broker_account_id, metaapi_order_id, symbol, direction,
  status, opened_at, closed_at, profit, created_at
) values (
  '40000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000001',
  'eligible-1', 'EURUSD', 'sell', 'closed',
  now() - interval '1 day', now() - interval '23 hours', 999,
  '2026-01-01T00:00:00Z'
);

-- Same owner, different broker account: must never enter source A metrics.
insert into public.trades (
  user_id, broker_account_id, metaapi_order_id, symbol, direction,
  status, opened_at, closed_at, profit
) values (
  '40000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000002',
  'unrelated-1', 'XAUUSD', 'buy', 'closed', now() - interval '3 days', now() - interval '2 days', 100000
);

-- A social-copy destination execution is excluded even if a future ingestion
-- path also persists it in public.trades.
insert into public.social_copy_sources (id, trader_user_id, broker_account_id, status, label)
values ('42000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', '41000000-0000-0000-0000-000000000004', 'published', 'Upstream');
insert into public.social_copy_subscriptions (
  id, source_id, source_trader_user_id, subscriber_user_id, destination_broker_account_id,
  sizing_mode, fixed_lot, lot_multiplier, max_lot, requested_account_mode, status, desired_status
) values (
  '43000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000003',
  '40000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000001', 'fixed_lot', 0.01, 1, 0.1, 'demo', 'active', 'active'
);
insert into public.social_copy_trade_mappings (
  subscription_id, source_ticket, destination_ticket, source_symbol, destination_symbol,
  source_side, source_volume, destination_volume, state, broker_comment
) values (
  '43000000-0000-0000-0000-000000000001', 'upstream-1', 'copied-1', 'GBPUSD', 'GBPUSD',
  'buy', 0.1, 0.01, 'closed', 'sc:test:copied-1'
);
insert into public.trades (
  user_id, broker_account_id, metaapi_order_id, symbol, direction,
  status, opened_at, closed_at, profit
) values (
  '40000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000001',
  'copied-1', 'GBPUSD', 'buy', 'closed', now() - interval '2 days', now() - interval '1 day', 500
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.register_social_profile()$$, 'provider joins social directory');
select ok(
  set_config(
    'test.source_a_id',
    public.publish_social_copy_source('41000000-0000-0000-0000-000000000001', 'Published A')::text,
    true
  ) <> '',
  'provider publishes account A explicitly'
);

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.register_social_profile()$$, 'viewer joins social directory');
select throws_ok(
  $$select * from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')$$,
  '42501', 'Trader has not shared trade history with this viewer',
  'performance is private until explicit history consent'
);

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.set_social_trade_history_sharing(true)$$, 'provider enables history sharing');

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select count(*)::integer from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 1, 'one published source produces one performance scope');
select is((select closed_trade_count::integer from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 10, 'duplicates, copied trades, and the other account are excluded');
select is((select open_trade_count::integer from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 1, 'open trades are reported separately without entering closed performance');
select is((select realized_profit from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 55::numeric, 'realized P/L uses complete source-account results only');
select is((select win_rate from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 70.00::numeric, 'win rate includes every complete closed trade in the denominator');
select is((select profit_factor from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 4.6667::numeric, 'profit factor uses gross profits divided by absolute gross losses');
select is((select return_percentage from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), null::numeric, 'return remains explicitly unavailable without cash-flow history');
select is((select maximum_drawdown from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), null::numeric, 'drawdown remains unavailable without equity history');
select is((select equity_curve_available from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), false, 'equity curve is not claimed');
select is((select count(*)::integer from public.get_social_source_trade_history((select source_id from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')))), 11, 'source history is deduplicated and includes source-account open positions');
select is((select count(*)::integer from public.get_social_source_trade_history((select source_id from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001'))) where symbol = 'XAUUSD'), 0, 'same-owner unrelated account is isolated');
select is((select count(*)::integer from public.get_social_source_trade_history((select source_id from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001'))) where symbol = 'GBPUSD'), 0, 'internally copied destination trade is excluded');
select ok(public.create_social_copy_subscription(
  (select source_id from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')),
  '41000000-0000-0000-0000-000000000003', 'fixed_lot', 0.01, 1, 0.1, null, 'demo', '{}'
) is not null, 'server permits a fresh complete demo provider meeting the minimum policy');

reset role;
update public.broker_accounts set last_synced_at = now() - interval '1 hour'
where id = '41000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 'stale', 'old successful sync is reported as stale');
select throws_ok(
  $$select public.create_social_copy_subscription(
    (select source_id from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')),
    '41000000-0000-0000-0000-000000000003', 'fixed_lot', 0.01, 1, 0.1, null, 'demo', '{}')$$,
  '55000', 'Provider is not eligible for copying: history_stale',
  'server blocks copy creation when history is stale'
);

reset role;
set local role service_role;
select is(public.check_social_copy_subscription_authorization(
  (select id from public.social_copy_subscriptions where subscriber_user_id = '40000000-0000-0000-0000-000000000002')
), false, 'worker authorization revokes an existing subscription after eligibility becomes stale');

reset role;
update public.broker_accounts set connection_status = 'error', last_synced_at = now()
where id = '41000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 'failed', 'connection error is reported as synchronization failure');

reset role;
update public.broker_accounts set connection_status = 'connected' where id = '41000000-0000-0000-0000-000000000001';
insert into public.trades (user_id, broker_account_id, metaapi_order_id, symbol, direction, status, opened_at, closed_at, profit)
values ('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', 'missing-result', 'USDJPY', 'buy', 'closed', now() - interval '1 day', now(), null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 'incomplete', 'missing realized result is explicit instead of being counted as zero');

reset role;
delete from public.trades where metaapi_order_id = 'missing-result';
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
select ok(public.publish_social_copy_source('41000000-0000-0000-0000-000000000002', 'Published B') is not null, 'provider can replace the selected source with another owned account');
select is((select count(*)::integer from public.social_copy_sources where trader_user_id = '40000000-0000-0000-0000-000000000001' and status = 'published'), 1, 'exactly one source account remains selected and published');
select is((select status from public.social_copy_sources where id = current_setting('test.source_a_id')::uuid), 'paused', 'replaced source is retained but no longer published');
select is((select desired_status from public.social_copy_subscriptions where source_id = current_setting('test.source_a_id')::uuid and subscriber_user_id = '40000000-0000-0000-0000-000000000002'), 'paused', 'replacing a source pauses existing subscriptions through the worker lifecycle');
select is((select count(*)::integer from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 2, 'owner can audit the selected and prior account scopes without mixing them');
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001') where source_label = 'Published B'), 'available', 'second account reports its own available history');
select lives_ok($$select public.set_social_copy_source_status(
  current_setting('test.source_a_id')::uuid,
  'published')$$, 'status RPC can reselect a prior source without violating the one-selected-account invariant');
select is((select count(*)::integer from public.social_copy_sources where trader_user_id = '40000000-0000-0000-0000-000000000001' and status = 'published'), 1, 'status RPC leaves exactly one selected source');
select is((select source_id from public.social_copy_subscriptions where subscriber_user_id = '40000000-0000-0000-0000-000000000002' and desired_status = 'paused'), current_setting('test.source_a_id')::uuid, 'source replacement never resumes a paused subscription implicitly');
select lives_ok($$select public.set_social_copy_source_status(
  current_setting('test.source_a_id')::uuid,
  'retired')$$, 'provider can unpublish source A');

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select count(*)::integer from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 1, 'viewer no longer sees an unpublished source');
select throws_ok(
  $$select * from public.get_social_source_trade_history(
    current_setting('test.source_a_id')::uuid)$$,
  'P0002', 'Published source is not available',
  'viewer cannot read history through an unpublished source id'
);

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
select is((select count(*)::integer from public.get_social_source_trade_history(
  current_setting('test.source_a_id')::uuid)), 11, 'owner retains access to source-scoped open and closed history after unpublishing');

select ok(public.publish_social_copy_source('41000000-0000-0000-0000-000000000005', 'Empty live account') is not null, 'provider can select an owned live account without claiming demo status');
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001') where source_status = 'published'), 'no_history', 'selected account with no trades reports no qualifying history');
select is((select account_mode from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001') where source_status = 'published'), 'live', 'account environment is derived from the broker account and reported as LIVE');

select * from finish();
rollback;
