-- Gate: paid providers require active social_copy_billing; free path unchanged.
-- Run against Migration with pgTAP / supabase test db when available.

begin;
select plan(3);

select has_function(
  'public',
  'has_active_social_copy_billing',
  array['uuid', 'uuid'],
  'has_active_social_copy_billing exists'
);

select has_table('public', 'social_copy_billing', 'social_copy_billing table exists');

select has_column('public', 'social_profiles', 'stripe_connect_charges_enabled', 'provider Connect flag exists');

select * from finish();
rollback;
