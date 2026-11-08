begin;

select plan(56);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data
)
values
  ('10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'open@example.test', '', now(), '{"providers":["email"]}'),
  ('10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'private@example.test', '', now(), '{"providers":["email"]}'),
  ('10000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'actor@example.test', '', now(), '{"providers":["email"]}'),
  ('10000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'unverified@example.test', '', now(), '{"providers":["email"]}'),
  ('10000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'incomplete@example.test', '', now(), '{"providers":["email"]}'),
  ('10000000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', 'unregistered@example.test', '', now(), '{"providers":["email"]}');

update public.user_profiles
set display_name = case user_id
      when '10000000-0000-0000-0000-000000000001' then 'Open Trader'
      when '10000000-0000-0000-0000-000000000002' then 'Private Trader'
      when '10000000-0000-0000-0000-000000000003' then 'Verified Actor'
      when '10000000-0000-0000-0000-000000000004' then 'Unverified Actor'
      when '10000000-0000-0000-0000-000000000006' then 'Unregistered Actor'
      else ''
    end,
    username = case user_id
      when '10000000-0000-0000-0000-000000000001' then 'open-trader'
      when '10000000-0000-0000-0000-000000000002' then 'private-trader'
      when '10000000-0000-0000-0000-000000000003' then 'verified-actor'
      when '10000000-0000-0000-0000-000000000004' then 'unverified-actor'
      when '10000000-0000-0000-0000-000000000006' then 'unregistered-actor'
      else ''
    end,
    email_verified_at = case
      when user_id = '10000000-0000-0000-0000-000000000004' then null
      else now()
    end
where user_id in (
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000006'
);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
)
values (
  '10000000-0000-0000-0000-000000000007',
  'authenticated',
  'authenticated',
  'oauth@example.test',
  '',
  now(),
  '{"providers":["google"]}',
  '{"full_name":"OAuth Participant","user_name":"oauth-participant"}'
);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
)
values (
  '10000000-0000-0000-0000-000000000008',
  'authenticated',
  'authenticated',
  'oauth-provider@example.test',
  '',
  now(),
  '{"provider":"google"}',
  '{"full_name":"OAuth Provider Participant"}'
);

-- A deliberately corrupt setup row proves the RPC rejects an incomplete
-- participant even if privileged code bypassed normal registration.
insert into public.social_profiles (user_id)
values ('10000000-0000-0000-0000-000000000005');

-- Existing rows are retained, but invalid participants must not inflate public counts.
insert into public.social_follow_relationships (follower_user_id, followed_user_id, status)
values ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'accepted');

set local role anon;
select is(
  has_function_privilege('anon', 'public.follow_social_profile(uuid)', 'EXECUTE'),
  false,
  'anonymous role cannot execute follow RPC'
);
select throws_ok(
  $$select public.follow_social_profile('10000000-0000-0000-0000-000000000001')$$,
  '42501',
  null,
  'anonymous follow execution is denied'
);
select throws_ok(
  $$insert into public.social_follow_relationships (follower_user_id, followed_user_id, status)
    values ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'accepted')$$,
  '42501',
  null,
  'anonymous direct relationship insert is denied'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$insert into public.social_follow_relationships (follower_user_id, followed_user_id, status)
    values ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'accepted')$$,
  '42501',
  null,
  'authenticated direct relationship insert is denied'
);
select throws_ok(
  $$update public.social_follow_relationships set status = 'accepted'$$,
  '42501',
  null,
  'authenticated direct relationship update is denied'
);
select throws_ok(
  $$delete from public.social_follow_relationships$$,
  '42501',
  null,
  'authenticated direct relationship delete is denied'
);
select throws_ok(
  $$insert into public.social_profiles (user_id) values ('10000000-0000-0000-0000-000000000006')$$,
  '42501',
  null,
  'authenticated direct profile registration is denied'
);

select is(
  has_function_privilege('authenticated', 'public.follow_social_profile(uuid)', 'EXECUTE'),
  true,
  'authenticated role can execute public follow RPC'
);
select is(
  has_function_privilege('authenticated', 'public.social_follow_actor_is_verified(uuid)', 'EXECUTE'),
  false,
  'authenticated role cannot execute verification helper'
);
select is(
  has_function_privilege('authenticated', 'public.social_follow_profile_is_eligible(uuid)', 'EXECUTE'),
  false,
  'authenticated role cannot execute profile eligibility helper'
);
select ok(
  (select prosecdef from pg_proc where oid = 'public.follow_social_profile(uuid)'::regprocedure),
  'follow RPC is security definer'
);
select ok(
  (select 'search_path=pg_catalog, public' = any(proconfig)
   from pg_proc where oid = 'public.follow_social_profile(uuid)'::regprocedure),
  'follow RPC has a fixed safe search path'
);
select ok(
  (select pg_get_userbyid(proowner) not in ('anon', 'authenticated')
   from pg_proc where oid = 'public.follow_social_profile(uuid)'::regprocedure),
  'follow RPC is not owned by an application role'
);
select ok(
  not has_schema_privilege('anon', 'public', 'CREATE'),
  'anonymous role cannot create objects in public schema'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.register_social_profile()$$, 'verified open user can register');
select lives_ok($$select public.set_social_profile_access('open')$$, 'owner can make profile open');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.register_social_profile()$$, 'verified private user can register');
select lives_ok($$select public.set_social_profile_access('private')$$, 'owner can make profile private');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
select lives_ok($$select public.register_social_profile()$$, 'verified actor can register');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000007', true);
select lives_ok(
  $$select public.register_social_profile()$$,
  'confirmed OAuth user remains eligible under the application verification rule'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000008', true);
select lives_ok(
  $$select public.register_social_profile()$$,
  'confirmed OAuth user with scalar provider metadata is eligible like the frontend rule'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);

select throws_ok(
  $$update public.user_profiles set display_name = '', username = ''
    where user_id = '10000000-0000-0000-0000-000000000003'$$,
  '23514',
  'A listed social profile requires a display name or username',
  'listed participant cannot make public identity incomplete'
);
select is(
  (select count(*)::integer from public.get_social_directory()
   where profile_user_id = '10000000-0000-0000-0000-000000000003'),
  1,
  'rejected identity update leaves participant in the eligible directory'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000004', true);
select throws_ok(
  $$select public.register_social_profile()$$,
  '42501',
  'Social Follow requires a verified account',
  'verification-ineligible user cannot register'
);
select throws_ok(
  $$select public.set_social_profile_access('open')$$,
  '42501',
  'Social Follow requires a verified account',
  'verification-ineligible user cannot change access'
);
select throws_ok(
  $$select public.follow_social_profile('10000000-0000-0000-0000-000000000001')$$,
  '42501',
  'Social Follow requires a verified account',
  'verification-ineligible user cannot follow by direct RPC'
);
select throws_ok(
  $$select public.remove_social_follow('10000000-0000-0000-0000-000000000001')$$,
  '42501',
  'Social Follow requires a verified account',
  'verification-ineligible user cannot remove by direct RPC'
);
select throws_ok(
  $$select public.resolve_social_follow_request('10000000-0000-0000-0000-000000000003', 'accepted')$$,
  '42501',
  'Social Follow requires a verified account',
  'verification-ineligible user cannot resolve by direct RPC'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000006', true);
select throws_ok(
  $$select public.follow_social_profile('10000000-0000-0000-0000-000000000001')$$,
  '55000',
  'Following requires a registered, listed social profile with a public identity',
  'unregistered verified user cannot follow an open profile'
);
select throws_ok(
  $$select public.follow_social_profile('10000000-0000-0000-0000-000000000002')$$,
  '55000',
  'Following requires a registered, listed social profile with a public identity',
  'unregistered verified user cannot request a private profile'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000005', true);
select throws_ok(
  $$select public.follow_social_profile('10000000-0000-0000-0000-000000000001')$$,
  '55000',
  'Following requires a registered, listed social profile with a public identity',
  'registered user with incomplete identity cannot follow'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select public.follow_social_profile('10000000-0000-0000-0000-000000000003')$$,
  '23514',
  'Users cannot follow themselves',
  'self follow is rejected'
);
select is(
  public.follow_social_profile('10000000-0000-0000-0000-000000000001'),
  'accepted',
  'valid participant follows open profile immediately'
);
select is(
  public.follow_social_profile('10000000-0000-0000-0000-000000000001'),
  'accepted',
  'repeated public follow is idempotent'
);
select is(
  (select count(*)::integer from public.social_follow_relationships
   where follower_user_id = '10000000-0000-0000-0000-000000000003'
     and followed_user_id = '10000000-0000-0000-0000-000000000001'),
  1,
  'sequential duplicate public follows retain one row'
);
select is(
  public.follow_social_profile('10000000-0000-0000-0000-000000000002'),
  'pending',
  'valid participant request to private profile starts pending'
);
select is(
  public.follow_social_profile('10000000-0000-0000-0000-000000000002'),
  'pending',
  'repeated private request is idempotent'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.resolve_social_follow_request('10000000-0000-0000-0000-000000000003', 'accepted')$$,
  'P0002',
  'Pending follow request was not found',
  'unrelated user cannot accept another profile request'
);
select throws_ok(
  $$select public.resolve_social_follow_request('10000000-0000-0000-0000-000000000003', 'declined')$$,
  'P0002',
  'Pending follow request was not found',
  'unrelated user cannot decline another profile request'
);
select lives_ok(
  $$select public.remove_social_follow('10000000-0000-0000-0000-000000000002')$$,
  'unrelated removal RPC is harmless and cannot target another follower'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
select is(
  (select viewer_relationship_status from public.get_social_directory()
   where profile_user_id = '10000000-0000-0000-0000-000000000002'),
  'pending',
  'unrelated removal leaves pending relationship intact'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$select public.set_social_profile_access('open')$$,
  'private owner can transition to open'
);
select is(
  (select status from public.social_follow_relationships
   where follower_user_id = '10000000-0000-0000-0000-000000000003'
     and followed_user_id = '10000000-0000-0000-0000-000000000002'),
  'accepted',
  'open transition accepts outstanding requests'
);
select lives_ok(
  $$select public.set_social_profile_access('private')$$,
  'open owner can transition back to private'
);
select is(
  (select status from public.social_follow_relationships
   where follower_user_id = '10000000-0000-0000-0000-000000000003'
     and followed_user_id = '10000000-0000-0000-0000-000000000002'),
  'accepted',
  'private transition preserves accepted relationship'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
select lives_ok(
  $$select public.remove_social_follow('10000000-0000-0000-0000-000000000002')$$,
  'accepted follower can unfollow'
);
select is(
  public.follow_social_profile('10000000-0000-0000-0000-000000000002'),
  'pending',
  'requester can create a fresh private request after unfollow'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$select public.resolve_social_follow_request('10000000-0000-0000-0000-000000000003', 'declined')$$,
  'recipient can decline own pending request'
);
select is(
  (select status from public.social_follow_relationships
   where follower_user_id = '10000000-0000-0000-0000-000000000003'
     and followed_user_id = '10000000-0000-0000-0000-000000000002'),
  'declined',
  'declined state persists'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
select is(
  public.follow_social_profile('10000000-0000-0000-0000-000000000002'),
  'pending',
  'declined request can be resubmitted consistently'
);
select lives_ok(
  $$select public.remove_social_follow('10000000-0000-0000-0000-000000000002')$$,
  'requester can cancel pending request'
);
select is(
  (select count(*)::integer from public.social_follow_relationships
   where follower_user_id = '10000000-0000-0000-0000-000000000003'
     and followed_user_id = '10000000-0000-0000-0000-000000000002'),
  0,
  'cancel removes pending request'
);
select is(
  (select follower_count::integer from public.get_social_directory()
   where profile_user_id = '10000000-0000-0000-0000-000000000001'),
  1,
  'accepted follower count excludes retained relationships from ineligible participants'
);
select is(
  (select following_count::integer from public.get_social_directory()
   where profile_user_id = '10000000-0000-0000-0000-000000000003'),
  1,
  'accepted following count is authoritative'
);
select is(
  (select count(*)::integer from public.get_social_directory()
   where profile_user_id = '10000000-0000-0000-0000-000000000005'),
  0,
  'incomplete profile never appears in production directory'
);
select is(
  (select count(*)::integer from public.social_follow_relationships
   where follower_user_id = '10000000-0000-0000-0000-000000000002'),
  0,
  'RLS hides unrelated outgoing relationships'
);

select * from finish();
rollback;
