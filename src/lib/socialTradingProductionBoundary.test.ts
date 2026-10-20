import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../pages/dashboard/SocialTradingPage.tsx', import.meta.url), 'utf8')
const directory = readFileSync(new URL('../components/social/SocialFollowDirectory.tsx', import.meta.url), 'utf8')
const history = readFileSync(new URL('../components/social/SocialTradeHistoryPanel.tsx', import.meta.url), 'utf8')

test('fixture ratings and performance remain development-only', () => {
  const demoGate = page.indexOf('{import.meta.env.DEV ? (')
  const fixtureRows = page.indexOf('{traders.map(trader => {')
  assert.ok(demoGate >= 0, 'demo directory must have an explicit Vite development gate')
  assert.ok(fixtureRows > demoGate, 'fixture-backed rows must remain inside the development gate')
  assert.match(page, /if \(traderId && \(!trader \|\| !import\.meta\.env\.DEV\)\)/)

  const ratingStart = page.indexOf('function TraderRating(')
  const ratingEnd = page.indexOf('export function SocialTradingPage()', ratingStart)
  const displayOnlyRating = page.slice(ratingStart, ratingEnd)
  assert.match(displayOnlyRating, /return \(\s*<p /)
  assert.doesNotMatch(displayOnlyRating, /<button|onClick=|role="radio"/)
})

test('production profile uses persisted reviews and the consent-aware real-history boundary', () => {
  const profileStart = directory.indexOf('export function SocialFollowProfile')
  const productionProfile = directory.slice(profileStart)
  assert.match(productionProfile, /TraderReviews/)
  assert.match(productionProfile, /SocialTradeHistoryPanel/)
  assert.doesNotMatch(productionProfile, /TraderRating|previewBalance|closedPerformance|SOCIAL_TRADERS/)
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
  assert.match(history, /Maximum drawdown[^]*Unavailable/)
  assert.match(history, /Destination-side copy executions are excluded/)
  assert.doesNotMatch(history, /SOCIAL_TRADERS|previewBalance|monthlyCopyPriceCents/)
})
