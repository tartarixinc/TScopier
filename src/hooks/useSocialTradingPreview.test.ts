// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { hydrateTrader } from './useSocialTradingPreview'
import { canOpenCopyTrader } from '../lib/socialCopyAvailability'
import type { SocialCopySource } from '../lib/socialCopy'
import type { SocialProviderPerformance, SocialTradeHistoryItem } from '../lib/socialTradeHistory'
import type { SocialTrader } from '../lib/socialTradingFixture'
import { eligibilityDiagnosticForReason } from '../lib/socialEligibility'

const base: SocialTrader = {
  id: 'trader', displayName: 'Trader', username: 'trader', isYou: false, access: 'open',
  monthlyCopyPriceCents: 0, allowFollowing: true, roi: null, winRate: null, maxDrawdown: null,
  closedTrades: null, followerCount: 1, rating: null, ratingCount: 0, following: false,
  followsYou: false, previewBalance: null, syntheticDemo: false,
  profile: { joinedAt: null, rank: null, leverage: null, country: '', timezone: null },
  openTrades: [], closedPerformance: [], activities: [], chart: { series: [], growth: [], outcome: [] },
}

const source: SocialCopySource = {
  sourceId: 'source', label: 'Source', provider: 'fxsocket', platform: 'MT5',
  accountHint: '•••1234',
  accountMode: 'demo', connectionHealthy: true, isCopyEligible: true, eligibilityReason: 'eligible',
  eligibilityDiagnostics: [eligibilityDiagnosticForReason('eligible')], isSynthetic: false,
}

const performance: SocialProviderPerformance = {
  sourceId: 'source', sourceLabel: 'Source', sourceStatus: 'published', performanceStatus: 'available',
  statusReason: 'current', accountMode: 'demo', currency: 'USD', periodStartedAt: '2026-10-01T00:00:00Z',
  periodEndedAt: '2026-10-02T00:00:00Z', lastSyncSucceededAt: '2026-10-02T00:00:00Z',
  calculatedAt: '2026-10-02T00:00:00Z', historyComplete: true, openTradeCount: 0, closedTradeCount: 1,
  realizedProfit: 0, winRate: 0, profitFactor: 0, returnPercentage: null, maximumDrawdown: null,
  equityCurveAvailable: false, isCopyEligible: true, eligibilityReason: 'eligible', isSynthetic: false,
}

const flatTrade: SocialTradeHistoryItem = {
  tradeId: 'flat', symbol: 'EURUSD', direction: 'buy', status: 'closed', openedAt: '2026-10-01T00:00:00Z',
  closedAt: '2026-10-02T00:00:00Z', realizedProfit: 0,
}

describe('social trading preview hydration', () => {
  it('preserves genuine zero values from successful requests', () => {
    const trader = hydrateTrader(base, [flatTrade], performance, source)
    expect(trader.winRate).toBe(0)
    expect(trader.closedTrades).toBe(1)
    expect(trader.closedPerformance[0]?.profit).toBe(0)
    expect(trader.historyAvailable).toBe(true)
    expect(trader.sourceLabel).toBe('Source')
    expect(trader.sourceProvider).toBe('fxsocket')
    expect(trader.sourcePlatform).toBe('MT5')
  })

  it('retains source eligibility when only the aggregate performance request fails', () => {
    const trader = hydrateTrader(base, [flatTrade], null, source, 'Performance request failed: unavailable')
    expect(trader.sourceId).toBe('source')
    expect(trader.copyEligible).toBe(true)
    expect(trader.closedTrades).toBeNull()
    expect(trader.winRate).toBeNull()
    expect(trader.historyComplete).toBe(false)
    expect(trader.performanceError).toMatch(/Performance request failed/)
  })

  it('distinguishes a failed history request from genuine empty history', () => {
    const failed = hydrateTrader(base, null, performance, source, 'Trade-history request failed')
    const empty = hydrateTrader(base, [], { ...performance, performanceStatus: 'no_history', openTradeCount: 0, closedTradeCount: 0 }, source)
    expect(failed.historyAvailable).toBe(false)
    expect(failed.closedTrades).toBeNull()
    expect(empty.historyAvailable).toBe(true)
    expect(empty.historyComplete).toBe(true)
    expect(empty.closedTrades).toBe(0)
    expect(empty.openTradeCount).toBe(0)
  })

  it('does not mix incomplete or duplicate history with complete totals', () => {
    const incomplete = hydrateTrader(base, [flatTrade], { ...performance, performanceStatus: 'incomplete', closedTradeCount: 2 }, source)
    const duplicate = hydrateTrader(base, [flatTrade, { ...flatTrade }], performance, source)
    expect(incomplete.closedPerformance).toHaveLength(1)
    expect(incomplete.closedTrades).toBeNull()
    expect(incomplete.winRate).toBeNull()
    expect(incomplete.historyComplete).toBe(false)
    expect(duplicate.closedTrades).toBeNull()
    expect(duplicate.historyComplete).toBe(false)
  })

  it('preserves verified zero and positive live copier counts', () => {
    expect(hydrateTrader(base, [flatTrade], performance, source, null, [source], 0).liveCopiers).toBe(0)
    expect(hydrateTrader(base, [flatTrade], performance, source, null, [source], 3).liveCopiers).toBe(3)
  })

  it('recognizes server-authorized synthetic traders and permits the persisted simulated flow', () => {
    const trader = hydrateTrader(base, [flatTrade], performance, { ...source, isCopyEligible: true, eligibilityReason: 'eligible', isSynthetic: true })
    expect(trader.syntheticDemo).toBe(true)
    expect(trader.copyEligible).toBe(true)
    expect(canOpenCopyTrader(trader)).toBe(true)
  })

  it('requires both a published source and backend eligibility for real traders', () => {
    const eligible = hydrateTrader(base, [flatTrade], performance, source)
    const ineligible = hydrateTrader(base, [flatTrade], performance, { ...source, isCopyEligible: false, eligibilityReason: 'minimum_trades_not_met' })
    expect(canOpenCopyTrader(eligible)).toBe(true)
    expect(canOpenCopyTrader(ineligible)).toBe(false)
    expect(canOpenCopyTrader({ ...eligible, sourceId: null })).toBe(true)
    expect(canOpenCopyTrader({ ...eligible, sourceId: null, sources: [] })).toBe(false)
  })
})
