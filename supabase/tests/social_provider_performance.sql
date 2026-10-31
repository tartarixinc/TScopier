begin;

select plan(73);

select is(public.social_trade_ticket_is_verified(null), false, 'null broker ticket is unverified');
select is(public.social_trade_ticket_is_verified(''), false, 'blank broker ticket is unverified');
select is(public.social_trade_ticket_is_verified('  '), false, 'whitespace broker ticket is unverified');
select is(public.social_trade_ticket_is_verified('NaN'), false, 'NaN broker ticket is unverified');
select is(public.social_trade_ticket_is_verified('000123'), true, 'positive numeric ticket is verified');
select is(public.social_trade_ticket_is_verified('123x'), false, 'malformed broker ticket is unverified');
select is(public.social_trade_ticket_is_verified('0'), false, 'zero broker ticket is unverified');
select is(public.social_trade_ticket_is_verified('-1'), false, 'negative broker ticket is unverified');
select is(public.social_trade_ticket_is_verified('Infinity'), false, 'infinite broker ticket is unverified');
select is(public.social_trade_ticket_is_verified('9007199254740992'), false, 'unsafe integer broker ticket is unverified');
select is(public.social_normalize_trade_ticket('fxsocket', '000123'), '123', 'numeric leading zeroes canonicalize');
select is(public.social_normalize_trade_ticket('mtapi', '123'), '123', 'MTAPI positive safe integer canonicalizes');
select is(public.social_normalize_trade_ticket('ctrader', ' deal-abc-01 '), 'deal-abc-01', 'opaque provider identity is preserved without numeric conversion');
select is(public.social_trade_ticket_is_verified('ctrader', 'deal-abc-01'), true, 'opaque provider identity is verified when its provider permits it');
select is(public.social_trade_ticket_is_verified('mtapi', 'deal-abc-01'), false, 'opaque identity is rejected for numeric-ticket providers');
select is(public.social_normalize_trade_ticket('ctrader', E'bad\nidentity'), null, 'opaque identity with control characters is rejected');

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
  (600000 + n)::text,
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
  '600011', 'USDJPY', 'buy', 'open', now() - interval '2 hours', null
);

-- Historical duplicate: pre-cutoff rows are not covered by the later unique
-- index, so the social query must collapse this ticket itself.
insert into public.trades (
  user_id, broker_account_id, metaapi_order_id, symbol, direction,
  status, opened_at, closed_at, profit, created_at
) values (
  '40000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000001',
  '600001', 'EURUSD', 'sell', 'closed',
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
  '700001', 'XAUUSD', 'buy', 'closed', now() - interval '3 days', now() - interval '2 days', 100000
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
  '43000000-0000-0000-0000-000000000001', '900001', '620999', 'GBPUSD', 'GBPUSD',
  'buy', 0.1, 0.01, 'closed', 'sc:test:620999'
);
insert into public.trades (
  user_id, broker_account_id, metaapi_order_id, symbol, direction,
  status, opened_at, closed_at, profit
) values (
  '40000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000001',
  '620999', 'GBPUSD', 'buy', 'closed', now() - interval '2 days', now() - interval '1 day', 500
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
update public.social_copy_sources set is_synthetic = true
where id = current_setting('test.source_a_id')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select eligibility_reason from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 'synthetic_preview_disabled', 'synthetic source is visibly blocked while preview participation is disabled');
select is((select desired_status from public.social_copy_subscriptions where subscriber_user_id = '40000000-0000-0000-0000-000000000002'), 'active', 'refreshing a synthetic fixture marker does not alter subscription lifecycle state');
select is((select is_copy_eligible from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), false, 'synthetic source is ineligible while the server preview gate is disabled');
select is((select eligibility_reason from public.get_social_copy_sources('40000000-0000-0000-0000-000000000001')), 'synthetic_preview_disabled', 'source discovery exposes the disabled preview gate');
select throws_ok(
  $$select public.create_social_copy_subscription(
    current_setting('test.source_a_id')::uuid,
    '41000000-0000-0000-0000-000000000003', 'fixed_lot', 0.01, 1, 0.1, null, 'demo', '{}')$$,
  'P0002', 'Social copy source is unavailable or ineligible',
  'subscription creation rejects synthetic sources while the preview gate is disabled'
);
reset role;
set local role service_role;
select is(public.check_social_copy_subscription_authorization(
  (select id from public.social_copy_subscriptions where subscriber_user_id = '40000000-0000-0000-0000-000000000002')
), false, 'worker authorization rejects an existing synthetic-source subscription');
reset role;
update public.social_copy_sources set is_synthetic = false
where id = current_setting('test.source_a_id')::uuid;

update public.broker_accounts set last_synced_at = now() - interval '1 hour'
where id = '41000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 'stale', 'old successful sync is reported as stale');
select throws_ok(
  $$select public.create_social_copy_subscription(
    current_setting('test.source_a_id')::uuid,
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
values
  ('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', '610001', 'USDJPY', 'buy', 'closed', now() - interval '1 day', now(), null),
  ('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', null, 'USDJPY', 'buy', 'closed', now() - interval '1 day', now(), 25),
  ('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', 'NaN', 'USDJPY', 'buy', 'closed', now() - interval '1 day', now(), 25),
  ('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', '610002', 'USDJPY', 'buy', 'closed', now() - interval '1 day', null, 25);
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 'incomplete', 'missing realized result is explicit instead of being counted as zero');
select is((select closed_trade_count::integer from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 14, 'ticketless, malformed, and unresolved closed rows remain in completeness counts');
select is((select realized_profit from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 55::numeric, 'unverified rows do not inflate known realized P/L');
select is((select win_rate from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 70.00::numeric, 'win rate denominator contains only verified results');
select is((select profit_factor from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 4.6667::numeric, 'partial profit factor uses only verified known wins and losses');
select is((select history_complete from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), false, 'unresolved closed rows prevent complete history');
select is((select count(*)::integer from public.get_social_source_trade_history(current_setting('test.source_a_id')::uuid)), 12, 'unverified ticket rows are excluded from trade history');
select is((select eligibility_reason from public.get_social_copy_sources('40000000-0000-0000-0000-000000000001')), 'history_incomplete', 'eligibility uses the unresolved closed-record definition');
select ok((
  select exists (
    select 1
    from public.get_social_copy_sources('40000000-0000-0000-0000-000000000001') source
    cross join lateral jsonb_array_elements(source.eligibility_diagnostics) check_row
    where check_row->>'code' = 'history_incomplete'
      and (check_row->>'blocking')::boolean
  )
), 'diagnostics expose the same incomplete-history eligibility blocker');

reset role;
update public.broker_accounts set last_synced_at = now() - interval '1 hour'
where id = '41000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 'stale', 'staleness remains visible when closed history is also incomplete');
reset role;
set local role service_role;
select is((
  select count(*)::integer
  from jsonb_array_elements(public.social_source_eligibility_diagnostics(current_setting('test.source_a_id')::uuid)) check_row
  where check_row->>'code' in ('history_stale', 'history_incomplete')
    and (check_row->>'blocking')::boolean
), 2, 'diagnostics report stale and incomplete history simultaneously');

reset role;
delete from public.trades where metaapi_order_id in ('610001', '610002', 'NaN') or metaapi_order_id is null;
update public.broker_accounts set last_synced_at = now()
where id = '41000000-0000-0000-0000-000000000001';
insert into public.trades (user_id, broker_account_id, metaapi_order_id, symbol, direction, status, opened_at)
values ('40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', null, 'USDJPY', 'buy', 'open', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 'incomplete', 'unverified open rows remain visible to integrity status');
select is((select history_complete from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), false, 'unverified open rows prevent a complete source snapshot');
reset role;
delete from public.trades where metaapi_order_id is null;
set local role authenticated;
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
select ok(public.publish_social_copy_source('41000000-0000-0000-0000-000000000002', 'Published B') is not null, 'provider can publish another owned account independently');
select is((select count(*)::integer from public.social_copy_sources where trader_user_id = '40000000-0000-0000-0000-000000000001' and status = 'published'), 2, 'multiple owned source accounts can remain published');
select is((select status from public.social_copy_sources where id = current_setting('test.source_a_id')::uuid), 'published', 'publishing another account leaves the existing source unchanged');
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select desired_status from public.social_copy_subscriptions where source_id = current_setting('test.source_a_id')::uuid and subscriber_user_id = '40000000-0000-0000-0000-000000000002'), 'active', 'publishing another source leaves existing subscriptions active');
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
select is((select count(*)::integer from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001')), 2, 'owner can audit both account scopes without mixing them');
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001') where source_label = 'Published B'), 'available', 'second account reports its own available history');
select lives_ok($$select public.set_social_copy_source_status(
  current_setting('test.source_a_id')::uuid,
  'paused')$$, 'status RPC can revoke one shared source independently');
select is((select count(*)::integer from public.social_copy_sources where trader_user_id = '40000000-0000-0000-0000-000000000001' and status = 'published'), 1, 'revocation leaves the other source published');
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select is((select source_id from public.social_copy_subscriptions where subscriber_user_id = '40000000-0000-0000-0000-000000000002' and desired_status = 'paused'), current_setting('test.source_a_id')::uuid, 'revoking one source requests a worker-acknowledged pause');
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
select public.publish_social_copy_source('41000000-0000-0000-0000-000000000002', 'Published B');
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
select is((select performance_status from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001') where source_label = 'Empty live account'), 'no_history', 'selected account with no trades reports no qualifying history');
select is((select account_mode from public.get_social_provider_performance('40000000-0000-0000-0000-000000000001') where source_label = 'Empty live account'), 'live', 'account environment is derived from the broker account and reported as LIVE');

select * from finish();
rollback;
