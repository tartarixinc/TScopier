/*
  Provider onboarding — grandfather existing providers.

  Profiles that already owned a published copy source before the application flow
  existed were marked approved by 20261101134804_provider_schema. Give each of them
  an approved application row (so they can edit their profile through
  update_provider_profile and cannot re-apply) and fill the account snapshot.
*/
select public.refresh_social_source_snapshots_internal(null);

insert into public.provider_applications
  (user_id, status, broker_account_id, declared_account_kind, monthly_price_cents,
   access_mode, bio, social_links, terms_accepted_at, submit_count, submitted_at,
   reviewed_at, created_at, updated_at)
select sp.user_id, 'approved', src.broker_account_id,
       case when src.account_kind in ('demo', 'live', 'prop') then src.account_kind else null end,
       coalesce(sp.monthly_copy_price_cents, 0), sp.access_mode, sp.bio,
       coalesce(up.social_links, '{}'::jsonb), now(), 0, null, now(), now(), now()
from public.social_profiles sp
join public.user_profiles up on up.user_id = sp.user_id
join lateral (
  select s.broker_account_id, s.account_kind
  from public.social_copy_sources s
  where s.trader_user_id = sp.user_id
  order by (s.status = 'published') desc, s.created_at asc
  limit 1
) src on true
where sp.provider_status = 'approved'
  and not exists (select 1 from public.provider_applications pa where pa.user_id = sp.user_id);
