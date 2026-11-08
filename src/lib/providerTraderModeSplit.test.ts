import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../../supabase/migrations/20261104232644_provider_trader_mode_split.sql', import.meta.url),
  'utf8',
)
const page = readFileSync(new URL('../pages/dashboard/SocialTradingPage.tsx', import.meta.url), 'utf8')
const applyPage = readFileSync(new URL('../pages/dashboard/ProviderApplyPage.tsx', import.meta.url), 'utf8')
const availability = readFileSync(new URL('./socialCopyAvailability.ts', import.meta.url), 'utf8')

test('approval cancels outgoing copies and pending paid intents', () => {
  assert.match(migration, /create or replace function public\.cancel_outgoing_social_copies_for_provider/)
  assert.match(migration, /desired_status = 'stopped'/)
  assert.match(migration, /status = 'reversed'/)
  assert.match(migration, /Cancelled on provider approval/)
  assert.match(migration, /perform public\.cancel_outgoing_social_copies_for_provider\(new\.user_id\)/)
  assert.match(migration, /old\.status is distinct from 'approved'/)
})

test('approved providers cannot create subscriptions or paywall intents', () => {
  assert.match(migration, /Approved providers cannot copy other providers/)
  assert.match(migration, /social_copy_reject_if_subscriber_is_provider/)
  assert.match(migration, /before insert on public\.social_copy_subscriptions/)
  assert.match(migration, /subscribe_social_copy_intent[\s\S]*provider_status = 'approved'/s)
  assert.match(availability, /viewerIsApprovedProvider/)
  assert.match(availability, /PROVIDER_CANNOT_COPY_REASON/)
})

test('providers can list their copiers', () => {
  assert.match(migration, /create or replace function public\.get_my_provider_copiers/)
  assert.match(migration, /grant execute on function public\.get_my_provider_copiers\(\) to authenticated/)
})

test('social trading splits trader directory from provider home', () => {
  assert.match(page, /isApprovedProvider/)
  assert.match(page, /providerHomeTitle/)
  assert.match(page, /ProviderCopiersPanel/)
  assert.match(page, /ProviderPaymentsPanel/)
  assert.match(page, /Become a provider/)
  assert.match(applyPage, /Stop copying when approved/)
  assert.match(applyPage, /fetchMySocialCopySubscriptions/)
})
