import { describe, expect, it } from 'vitest'
import { PROVIDER_CANNOT_COPY_REASON, canOpenCopyTrader, copyTraderUnavailableReason } from './socialCopyAvailability'
import { SOCIAL_TRADERS } from './socialTradingFixture'
import type { SocialCopySource } from './socialCopy'

const baseTrader = SOCIAL_TRADERS.find(trader => trader.id === 'amira-hassan')

const eligibleSource: SocialCopySource = {
  sourceId: 'source',
  label: 'Primary source',
  provider: 'mtapi',
  platform: 'MT5',
  accountHint: '••••1234',
  accountMode: 'live',
  connectionHealthy: true,
  isCopyEligible: true,
  eligibilityReason: 'eligible',
  eligibilityDiagnostics: [],
  isSynthetic: false,
}

describe('copy trader availability', () => {
  it('enables the Copy action when the server reports an eligible source', () => {
    expect(baseTrader).toBeDefined()
    const trader = { ...baseTrader!, sourceId: null, copyEligible: false, sources: [eligibleSource] }
    expect(canOpenCopyTrader(trader)).toBe(true)
    expect(copyTraderUnavailableReason(trader)).toBeNull()
  })

  it('keeps the Copy action unavailable when no source is eligible', () => {
    expect(baseTrader).toBeDefined()
    const trader = {
      ...baseTrader!,
      sources: [{ ...eligibleSource, isCopyEligible: false, eligibilityReason: 'history_stale' }],
    }
    expect(canOpenCopyTrader(trader)).toBe(false)
    expect(copyTraderUnavailableReason(trader)).toBe('The trader history is stale. Copying will be available after a fresh sync.')
  })

  it('ignores the retired minimum-trades and minimum-period gates', () => {
    expect(baseTrader).toBeDefined()
    for (const reason of ['minimum_trades_not_met', 'minimum_period_not_met'] as const) {
      const trader = {
        ...baseTrader!,
        sources: [{ ...eligibleSource, isCopyEligible: false, eligibilityReason: reason }],
        copyEligible: false,
        copyEligibilityReason: reason,
      }
      expect(canOpenCopyTrader(trader)).toBe(true)
      expect(copyTraderUnavailableReason(trader)).toBeNull()
    }
  })

  it('does not flash source_missing while trader sources are still loading', () => {
    expect(baseTrader).toBeDefined()
    const trader = {
      ...baseTrader!,
      sourceId: null,
      sources: [],
      copyEligible: false,
      copyEligibilityReason: 'source_missing',
      performanceStatusReason: 'not_loaded',
      performanceError: null,
    }
    expect(canOpenCopyTrader(trader)).toBe(false)
    expect(copyTraderUnavailableReason(trader)).toBeNull()
  })

  it('blocks approved providers from opening copy setup', () => {
    expect(baseTrader).toBeDefined()
    const trader = { ...baseTrader!, sourceId: null, copyEligible: false, sources: [eligibleSource] }
    expect(canOpenCopyTrader(trader, { viewerIsApprovedProvider: true })).toBe(false)
    expect(copyTraderUnavailableReason(trader, { viewerIsApprovedProvider: true })).toBe(PROVIDER_CANNOT_COPY_REASON)
  })
})
