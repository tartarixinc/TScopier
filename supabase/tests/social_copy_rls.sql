begin;

select plan(38);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data)
values
  ('20000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'source@example.test', '', now(), '{"providers":["email"]}'),
  ('20000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'subscriber@example.test', '', now(), '{"providers":["email"]}'),
  ('20000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'other@example.test', '', now(), '{"providers":["email"]}');

update public.user_profiles set
  display_name = case user_id
    when '20000000-0000-0000-0000-000000000001' then 'Source Trader'
    when '20000000-0000-0000-0000-000000000002' then 'Subscriber'
    else 'Other User' end,
  username = case user_id
    when '20000000-0000-0000-0000-000000000001' then 'source-trader'
    when '20000000-0000-0000-0000-000000000002' then 'subscriber'
    else 'other-user' end,
  email_verified_at = now()
where user_id::text like '20000000-%';

insert into public.subscriptions (id, user_id, stripe_customer_id, plan, status)
values
  ('20500000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'cus_socialcopy_source_001', 'basic', 'active'),
  ('20500000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'cus_socialcopy_subscriber_002', 'basic', 'active'),
  ('20500000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'cus_socialcopy_other_003', 'basic', 'active');

insert into public.broker_accounts (id, user_id, label, platform, metaapi_account_id, is_active)
values
  ('21000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Source demo', 'MT5', 'source-session', true),
  ('21000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Destination demo', 'MT5', 'destination-session', true),
  ('21000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'Other destination', 'MT5', 'other-session', true);

update public.broker_accounts
set provider = 'fxsocket',
    connection_status = 'connected',
    linked_account_type = 'Demo',
    last_synced_at = now(),
    last_currency = 'USD'
where id in (
  '21000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000002',
  '21000000-0000-0000-0000-000000000003'
);

insert into public.trades (
  user_id, broker_account_id, metaapi_order_id, symbol, direction,
  status, opened_at, closed_at, profit
)
select
  '20000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  'eligible-' || n,
  'EURUSD',
  case when n % 2 = 0 then 'buy' else 'sell' end,
  'closed',
  now() - make_interval(days => n),
  now() - make_interval(days => n) + interval '1 hour',
  case when n % 3 = 0 then -5 else 10 end
from generate_series(1, 10) n;

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.register_social_profile()$$, 'source trader can join social directory');
select lives_ok($$select public.set_social_profile_access('private')$$, 'source trader can require accepted follows');
select ok(set_config(
  'test.social_copy_source_id',
  public.publish_social_copy_source('21000000-0000-0000-0000-000000000001', 'Published demo')::text,
  true) <> '', 'owner can explicitly publish own broker account');
select throws_ok(
  $$select public.publish_social_copy_source('21000000-0000-0000-0000-000000000002', 'stolen')$$,
  '42501', 'Broker account is not owned by the current user',
  'trader cannot publish another user broker account'
);
select throws_ok(
  $$insert into public.social_copy_sources (trader_user_id, broker_account_id)
    values ('20000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001')$$,
  '42501', null, 'authenticated client cannot bypass source RPC'
);

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.register_social_profile()$$, 'subscriber can join social directory');
select is(
  (select count(*)::integer from public.get_social_copy_sources('20000000-0000-0000-0000-000000000001')),
  0, 'private source is hidden before an accepted follow'
);
select throws_ok(
  $$select public.create_social_copy_subscription(
    current_setting('test.social_copy_source_id')::uuid,
    '21000000-0000-0000-0000-000000000002', 'fixed_lot', 0.01, 1, 0.1, null, 'demo', '{}')$$,
  '42501', 'An accepted follow is required for this private trader',
  'private source subscription requires accepted follow authorization'
);
select is(public.follow_social_profile('20000000-0000-0000-0000-000000000001'), 'pending', 'private follow begins pending');

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.resolve_social_follow_request('20000000-0000-0000-0000-000000000002', 'accepted')$$, 'source accepts subscriber request');
select is((select count(*)::integer from public.in_app_notifications where event_type = 'social_follow_accepted'), 1, 'accepted follow notifies the followed trader');

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
select is(
  (select count(*)::integer from public.get_social_copy_sources('20000000-0000-0000-0000-000000000001')),
  1, 'accepted follower can discover consented source metadata'
);
select throws_ok(
  $$select public.create_social_copy_subscription(
    (select source_id from public.get_social_copy_sources('20000000-0000-0000-0000-000000000001') limit 1),
    '21000000-0000-0000-0000-000000000003', 'fixed_lot', 0.01, 1, 0.1, null, 'demo', '{}')$$,
  '42501', 'Destination account is not owned, connected, or supported for Social Trading',
  'subscriber cannot route copying into another user account'
);
select ok(public.create_social_copy_subscription(
  current_setting('test.social_copy_source_id')::uuid,
  '21000000-0000-0000-0000-000000000002', 'fixed_lot', 0.01, 1, 0.1, null, 'demo', '{}') is not null,
  'authorized subscriber can persist risk settings'
);
select throws_ok(
  $$select public.create_social_copy_subscription(
    current_setting('test.social_copy_source_id')::uuid,
    '21000000-0000-0000-0000-000000000002', 'fixed_lot', 0.01, 1, 0.1, null, 'demo', '{}')$$,
  '23505', 'A current subscription already exists for this source and destination',
  'duplicate current subscription is rejected'
);
select throws_ok(
  $$insert into public.social_copy_subscriptions (
    source_id, source_trader_user_id, subscriber_user_id, destination_broker_account_id,
    sizing_mode, fixed_lot, lot_multiplier, max_lot
  ) select id, trader_user_id, '20000000-0000-0000-0000-000000000002',
    '21000000-0000-0000-0000-000000000002', 'fixed_lot', 0.01, 1, 0.1
    from public.social_copy_sources limit 1$$,
  '42501', null, 'authenticated client cannot directly insert subscriptions'
);
select is((select status from public.social_copy_subscriptions limit 1), 'pending', 'subscription remains pending until worker acknowledgement');
reset role;
select is((select count(*)::integer from public.in_app_notifications where event_type = 'social_copy_activated'), 0, 'pending subscription does not create a false activation notification');
select lives_ok($$update public.social_copy_subscriptions set status = 'active', worker_acknowledged_at = now()$$, 'worker acknowledgement can activate subscription');
select lives_ok($$update public.social_copy_subscriptions set status = 'active', worker_acknowledged_at = now()$$, 'repeated worker reconciliation is harmless');
select is((select count(*)::integer from public.in_app_notifications where event_type = 'social_copy_activated'), 1, 'activation notification is deduplicated');
set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
select is((select count(*)::integer from public.in_app_notifications where event_type = 'social_copy_activated'), 1, 'source trader receives the new copier notification');
reset role;
select lives_ok($$update public.social_copy_subscriptions set status = 'error', error_code = 'TEST_SUSPENSION'$$, 'worker failure can suspend subscription');
set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
select is((select count(*)::integer from public.in_app_notifications where event_type = 'social_copy_suspended'), 1, 'subscriber receives suspension notification');
select lives_ok($$update public.in_app_notifications set read_at = now() where event_type = 'social_copy_suspended'$$, 'recipient can mark own notification read');
select ok((select read_at is not null from public.in_app_notifications where event_type = 'social_copy_suspended'), 'persistent read state is visible to recipient');
select lives_ok($$select public.set_social_copy_subscription_status((select id from public.social_copy_subscriptions limit 1), 'pause')$$, 'owner can request pause');
select is((select desired_status from public.social_copy_subscriptions limit 1), 'paused', 'pause desire persists');
select lives_ok($$select public.set_social_copy_subscription_status((select id from public.social_copy_subscriptions limit 1), 'resume')$$, 'owner can request resume');
select is((select desired_status from public.social_copy_subscriptions limit 1), 'active', 'resume desire persists');
select lives_ok($$select public.set_social_copy_subscription_status((select id from public.social_copy_subscriptions limit 1), 'emergency_stop')$$, 'owner can request emergency stop');
select is((select error_code from public.social_copy_subscriptions limit 1), 'EMERGENCY_STOP_REQUESTED', 'emergency stop awaits worker liquidation instead of claiming false completion');
select is(has_function_privilege('authenticated', 'public.claim_social_copy_subscriptions(text,integer,integer)', 'EXECUTE'), false, 'browser role cannot claim worker execution leases');

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select public.set_social_copy_subscription_status((select id from public.social_copy_subscriptions), 'stop')$$,
  'P0002', 'Current subscription was not found', 'other user cannot change subscriber lifecycle'
);
select is((select count(*)::integer from public.social_copy_subscriptions), 0, 'RLS hides another user subscriptions');
select is((select count(*)::integer from public.social_copy_trade_mappings), 0, 'RLS hides another user execution mappings');
select is((select count(*)::integer from public.social_copy_execution_events), 0, 'RLS hides another user audit events');
select is((select count(*)::integer from public.in_app_notifications), 0, 'RLS hides every other user notification');

select * from finish();
rollback;
