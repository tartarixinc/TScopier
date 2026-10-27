import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const settings = readFileSync(new URL('../components/settings/SocialTradingSettings.tsx', import.meta.url), 'utf8')
const selector = readFileSync(new URL('../components/social/OwnAccountSelector.tsx', import.meta.url), 'utf8')
const ownView = readFileSync(new URL('../hooks/useOwnSocialAccountView.ts', import.meta.url), 'utf8')
const modal = readFileSync(new URL('../components/social/CopyTraderModal.tsx', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../supabase/migrations/20261027100000_social_multi_account_sources.sql', import.meta.url), 'utf8')

test('settings scopes owned source management and keeps profile publication separate', () => {
  assert.match(settings, /fetchOwnSocialCopySources\(supabase, userId\)/)
  assert.match(settings, /publishSocialCopySource\(supabase, brokerId/)
  assert.match(settings, /setSocialCopySourceStatus\(supabase, existing\.sourceId, 'paused'\)/)
  assert.match(settings, /Profile visibility and account sharing are separate controls/)
  assert.match(settings, /Share for Copying/)
  assert.match(settings, /maskBrokerAccountIdentifier/)
})
test('the expandable You selector refreshes an authorized account-specific query without stale rows', () => {
  assert.match(selector, /aria-expanded=\{expanded\}/)
  assert.match(selector, /Demo|AccountModeBadge/)
  assert.match(ownView, /\.eq\('user_id', user\.id\)/)
  assert.match(ownView, /\.eq\('broker_account_id', accountId\)/)
  assert.match(ownView, /snapshot\.accountId === accountId/)
  assert.match(ownView, /openTrades: \[\]/)
})

test('copy setup requires an explicit eligible provider source', () => {
  assert.match(modal, /const \[selectedSourceId, setSelectedSourceId\] = useState\(''\)/)
  assert.match(modal, /sourceId: selectedSource\.sourceId/)
  assert.match(modal, /selectedSourceUsesLoadedPerformance/)
  assert.match(modal, /selectedSourceUsesLoadedPerformance \? trader\.openTrades\[0\]/)
  assert.match(modal, /disabled=\{disabled\}/)
  assert.doesNotMatch(modal, /selectedSourceId \|\| sources\[0\]/)
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
