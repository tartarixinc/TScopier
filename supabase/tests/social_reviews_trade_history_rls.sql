begin;

select plan(28);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data)
values
  ('30000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'rated-trader@example.test', '', now(), '{"providers":["email"]}'),
  ('30000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'reviewer@example.test', '', now(), '{"providers":["email"]}'),
  ('30000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'other-reviewer@example.test', '', now(), '{"providers":["email"]}');

update public.user_profiles set
  display_name = case user_id
    when '30000000-0000-0000-0000-000000000001' then 'Rated Trader'
    when '30000000-0000-0000-0000-000000000002' then 'Listed Reviewer'
    else 'Other Reviewer' end,
  username = case user_id
    when '30000000-0000-0000-0000-000000000001' then 'rated-trader'
    when '30000000-0000-0000-0000-000000000002' then 'listed-reviewer'
    else 'other-reviewer' end,
  email_verified_at = now()
where user_id::text like '30000000-%';

insert into public.subscriptions (id, user_id, stripe_customer_id, plan, status)
values (
  '30500000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000001',
  'cus_socialreviews_trader_001', 'basic', 'active'
);

insert into public.broker_accounts (
  id, user_id, label, platform, metaapi_account_id, provider, is_active,
  connection_status, linked_account_type, last_synced_at, last_currency
) values (
  '30500000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'Rated source', 'MT5', 'rated-source-session', 'fxsocket', true,
  'connected', 'Demo', now(), 'USD'
);

insert into public.trades (id, user_id, broker_account_id, metaapi_order_id, symbol, direction, status, opened_at, closed_at, profit)
values
  ('31000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '30500000-0000-0000-0000-000000000001', '730001', 'EURUSD', 'buy', 'open', now() - interval '1 hour', null, null),
  ('31000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', '30500000-0000-0000-0000-000000000001', '730002', 'XAUUSD', 'sell', 'closed', now() - interval '2 days', now() - interval '1 day', 42.50);

set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.register_social_profile()$$, 'trader can join the directory');
select ok(public.publish_social_copy_source('30500000-0000-0000-0000-000000000001', 'Rated source') is not null, 'trader publishes the exact source account used by history');
select is((select count(*)::integer from public.get_social_trade_history('30000000-0000-0000-0000-000000000001')), 2, 'owner can always view own real history');
select is((select sharing_enabled from public.get_social_trade_history_access('30000000-0000-0000-0000-000000000001')), false, 'trade-history sharing defaults off');

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.register_social_profile()$$, 'reviewer can join the directory');
select throws_ok(
  $$select public.upsert_social_trader_review('30000000-0000-0000-0000-000000000002', 5, 'self')$$,
  '23514', 'Users cannot review themselves', 'self reviews are rejected'
);
select throws_ok(
  $$select public.upsert_social_trader_review('30000000-0000-0000-0000-000000000001', 0, 'invalid')$$,
  '22023', 'Rating must be between 1 and 5', 'ratings below one are rejected'
);
select throws_ok(
  $$select public.upsert_social_trader_review('30000000-0000-0000-0000-000000000001', 6, 'invalid')$$,
  '22023', 'Rating must be between 1 and 5', 'ratings above five are rejected'
);
select ok(public.upsert_social_trader_review('30000000-0000-0000-0000-000000000001', 4, 'Consistent and clear.') is not null, 'authenticated reviewer can submit');
select ok(public.upsert_social_trader_review('30000000-0000-0000-0000-000000000001', 5, 'Updated after more trades.') is not null, 'same reviewer edits through upsert');
select is((select count(*)::integer from public.get_social_trader_reviews('30000000-0000-0000-0000-000000000001')), 1, 'edit does not create a duplicate review');
select is((select rating::integer from public.get_social_trader_reviews('30000000-0000-0000-0000-000000000001')), 5, 'edited rating persists');
select is((select reviewer_display_name from public.get_social_trader_reviews('30000000-0000-0000-0000-000000000001')), 'Listed Reviewer', 'listed reviewer identity follows directory privacy');
select is((select average_rating::numeric from public.get_social_directory() where profile_user_id = '30000000-0000-0000-0000-000000000001'), 5.00::numeric, 'directory average uses persisted reviews');
select is((select review_count::integer from public.get_social_directory() where profile_user_id = '30000000-0000-0000-0000-000000000001'), 1, 'directory review count uses persisted reviews');
select is(has_table_privilege('authenticated', 'public.social_trader_reviews', 'SELECT'), false, 'raw review rows and reviewer ids are not browser-readable');
select throws_ok(
  $$select * from public.get_social_trade_history('30000000-0000-0000-0000-000000000001')$$,
  '42501', 'Trader has not shared trade history with this viewer', 'history is private until explicit consent'
);

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.set_social_trade_history_sharing(true)$$, 'owner can explicitly share history');

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000002', true);
select is((select can_view from public.get_social_trade_history_access('30000000-0000-0000-0000-000000000001')), true, 'open profile history becomes visible after consent');
select is((select count(*)::integer from public.get_social_trade_history('30000000-0000-0000-0000-000000000001') where trade_status = 'open'), 1, 'open positions are distinguished');
select is((select count(*)::integer from public.get_social_trade_history('30000000-0000-0000-0000-000000000001') where trade_status = 'closed' and realized_profit = 42.50), 1, 'closed trades expose genuine realised profit');

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000003', true);
select lives_ok($$select public.register_social_profile()$$, 'other reviewer can join');
select ok(public.upsert_social_trader_review('30000000-0000-0000-0000-000000000001', 3, 'Different experience.') is not null, 'second reviewer can submit once');
select is((select average_rating::numeric from public.get_social_directory() where profile_user_id = '30000000-0000-0000-0000-000000000001'), 4.00::numeric, 'aggregate average is calculated across real records');
select is((select review_count::integer from public.get_social_directory() where profile_user_id = '30000000-0000-0000-0000-000000000001'), 2, 'aggregate count includes each unique reviewer once');
select throws_ok(
  $$update public.social_trader_reviews set reviewer_user_id = '30000000-0000-0000-0000-000000000002' where trader_user_id = '30000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'RLS prevents changing another authors review'
);
select lives_ok($$select public.delete_social_trader_review('30000000-0000-0000-0000-000000000001')$$, 'author can delete own review');
select is((select count(*)::integer from public.get_social_trader_reviews('30000000-0000-0000-0000-000000000001')), 1, 'delete removes only the authors review');

select * from finish();
rollback;
