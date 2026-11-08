import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const settings = readFileSync(new URL('../components/settings/SocialTradingSettings.tsx', import.meta.url), 'utf8')
const activityPage = readFileSync(new URL('../pages/dashboard/SocialTradingPage.tsx', import.meta.url), 'utf8')
const ownView = readFileSync(new URL('../hooks/useOwnSocialAccountView.ts', import.meta.url), 'utf8')
const modal = readFileSync(new URL('../components/social/CopyTraderModal.tsx', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../supabase/migrations/20261027100000_social_multi_account_sources.sql', import.meta.url), 'utf8')

test('settings scopes owned source management and keeps profile publication separate', () => {
  assert.match(settings, /fetchOwnSocialCopySources\(supabase, userId\)/)
  assert.match(settings, /publishSocialCopySource\(supabase, brokerId/)
  assert.match(settings, /setSocialCopySourceStatus\(supabase, existing\.sourceId, 'paused'\)/)
  assert.match(settings, /Manage your public provider profile and which accounts you share for copying/)
  assert.doesNotMatch(settings, /Who can follow/)
  assert.match(settings, /Share for Copying/)
  assert.match(settings, /maskBrokerAccountIdentifier/)
})
test('approved providers get a home dashboard; traders discover providers', () => {
  const providerPage = readFileSync(new URL('../pages/dashboard/ProviderApplyPage.tsx', import.meta.url), 'utf8')
  assert.match(activityPage, /export function OwnProviderProfileView/)
  assert.match(activityPage, /isApprovedProvider/)
  assert.match(activityPage, /ProviderCopiersPanel/)
  assert.match(activityPage, /ProviderPaymentsPanel/)
  assert.match(activityPage, /Become a provider/)
  assert.match(activityPage, /Navigate to="\/social-trading"/)
  assert.match(providerPage, /fetchMySocialCopySubscriptions/)
  assert.match(providerPage, /Stop copying when approved/)
  assert.doesNotMatch(providerPage, /OwnProviderProfileView/)
  assert.match(activityPage, /useDefaultOwnSourceAccount/)
  assert.doesNotMatch(activityPage, /OwnAccountSelector/)
  assert.match(ownView, /\.eq\('user_id', user\.id\)/)
  assert.match(ownView, /\.eq\('broker_account_id', accountId\)/)
  assert.match(ownView, /snapshot\.accountId === accountId/)
  assert.match(ownView, /openTrades: \[\]/)
  assert.match(ownView, /const seenTickets = new Set<string>\(\)/)
  assert.match(ownView, /Number\.isFinite\(profit\)/)
  assert.match(ownView, /closedRecords\.length === completeClosed\.length/)
  assert.match(ownView, /!hasUnverifiedRows/)
})

test('copy setup uses the provider registered source without a source picker', () => {
  assert.doesNotMatch(modal, /Provider source account/)
  assert.doesNotMatch(modal, /selectedSourceId/)
  assert.match(modal, /sourceId: selectedSource\.sourceId/)
  assert.match(modal, /sources\.find\(source => source\.isCopyEligible && source\.sourceId === trader\.sourceId\)/)
  assert.match(modal, /primaryDisabled=\{disabled\}/)
})

test('copy setup paywall unlocks Start copying after Stripe Checkout billing for paid providers only', () => {
  assert.match(modal, /startSocialCopyCheckout/)
  assert.match(modal, /confirmPaywallSubscribe/)
  assert.match(modal, /if \(showPaywall\)/)
  assert.match(modal, /c\.startCopying/)
  assert.match(modal, /isActiveSocialCopyBilling/)
  assert.match(modal, /setPaywallCleared\(true\)/)
})

test('multi-account sharing preserves authorization and pauses subscriptions on revocation', () => {
  assert.match(migration, /drop index if exists public\.social_copy_sources_one_published_per_trader_idx/)
  assert.match(migration, /b\.id = p_broker_account_id and b\.user_id = v_actor/)
  assert.match(migration, /where id = p_source_id and trader_user_id = v_actor/)
  assert.match(migration, /set desired_status = 'paused'/)
  assert.match(migration, /where source_id = p_source_id[\s\S]*status not in \('stopped', 'emergency_stopped'\)/)
  const publishBody = migration.slice(migration.indexOf('create or replace function public.publish_social_copy_source'), migration.indexOf('create or replace function public.set_social_copy_source_status'))
  assert.doesNotMatch(publishBody, /broker_account_id <> p_broker_account_id/)
})
