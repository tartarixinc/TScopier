
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../pages/dashboard/SocialTradingPage.tsx', import.meta.url), 'utf8')
const directory = readFileSync(new URL('../components/social/SocialFollowDirectory.tsx', import.meta.url), 'utf8')
const history = readFileSync(new URL('../components/social/SocialTradeHistoryPanel.tsx', import.meta.url), 'utf8')
const copyPanel = readFileSync(new URL('../components/social/SocialCopyPanel.tsx', import.meta.url), 'utf8')
const previewHook = readFileSync(new URL('../hooks/useSocialTradingPreview.ts', import.meta.url), 'utf8')
const copyModal = readFileSync(new URL('../components/social/CopyTraderModal.tsx', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../supabase/migrations/20261021130000_social_profile_links_and_demo_guard.sql', import.meta.url), 'utf8')

test('the approved preview is the single production Social Trading UI', () => {
  assert.match(page, /useSocialTradingPreview\(\)/)
  assert.match(page, /\{traders\.map\(trader => \{/)
  assert.match(page, /MonthlyProfitChart/)
  assert.match(page, /PnlCalendar/)
  assert.match(page, /TraderReviews/)
  assert.match(page, /SocialProfileLinks/)
  assert.doesNotMatch(page, /<SocialFollowDirectory|<SocialFollowProfile|import\.meta\.env\.DEV/)
  assert.doesNotMatch(page, /SOCIAL_TRADERS|socialTraderById/)
})

test('approved preview metrics and calendar load through consent-aware source history', () => {
  assert.match(previewHook, /fetchSocialTradeHistoryAccess/)
  assert.match(previewHook, /fetchSocialProviderPerformance/)
  assert.match(previewHook, /fetchSocialTradeHistory/)
  assert.match(previewHook, /realizedProfit/)
  assert.match(previewHook, /returnPercentage \?\? null/)
  assert.match(previewHook, /maximumDrawdown \?\? null/)
})

test('production social UI retains the approved directory and profile information architecture', () => {
  assert.match(directory, /Realized P\/L/)
  assert.match(directory, /Closed trades/)
  assert.match(directory, /AccountModeBadge/)
  assert.match(directory, /fetchSocialCopySources/)
  assert.match(history, /Performance/)
  assert.match(history, /Trading/)
  assert.match(history, /Portfolio/)
  assert.match(history, /Recent realized performance/)
  assert.match(history, /P\/L calendar/)
  assert.match(history, /DEMO DATA/)
  assert.match(history, /Maximum drawdown[^]*Unavailable/)
  assert.match(history, /Destination-side copy executions are excluded/)
  assert.doesNotMatch(history, /SOCIAL_TRADERS|previewBalance|monthlyCopyPriceCents/)
})

test('production directory keeps compact ratings in the Name column and copy controls reject demo data', () => {
  const nameCell = directory.slice(directory.indexOf('<tbody>'), directory.indexOf('<PerformanceCells'))
  assert.match(nameCell, /<TraderReviews compact/)

  const actionsStart = directory.indexOf('<td className="px-4 py-3 text-end">', directory.indexOf('<tbody>'))
  const actionsEnd = directory.indexOf('</td></tr>', actionsStart)
  const actionsCell = directory.slice(actionsStart, actionsEnd)
  assert.match(actionsCell, /FollowButton/)
  assert.doesNotMatch(actionsCell, /TraderReviews/)

  assert.match(copyPanel, /selectedSource\?\.isSynthetic \? <Alert/)
  assert.match(copyPanel, /!selectedSource\?\.isCopyEligible/)
})

test('approved Copy Trader modal persists through the existing subscription RPC', () => {
  assert.match(copyModal, /createSocialCopySubscription\(supabase/)
  assert.match(copyModal, /destinationBrokerAccountId: selectedBroker\.id/)
  assert.match(copyModal, /trader\.copyEligible/)
})

test('synthetic demo providers are protected in both source discovery and the write boundary', () => {
  assert.match(migration, /is_synthetic_demo boolean not null default false/)
  assert.match(migration, /eligibility\.eligible and not sp\.is_synthetic_demo/)
  assert.match(migration, /before insert or update of source_id on public\.social_copy_subscriptions/)
  assert.match(migration, /Synthetic demo traders cannot be copied/)
})
