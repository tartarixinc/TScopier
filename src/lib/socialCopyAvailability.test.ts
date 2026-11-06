import { describe, expect, it } from 'vitest'
import { canOpenCopyTrader, copyTraderUnavailableReason } from './socialCopyAvailability'
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
      sources: [{ ...eligibleSource, isCopyEligible: false, eligibilityReason: 'history_incomplete' }],
    }
    expect(canOpenCopyTrader(trader)).toBe(false)
    expect(copyTraderUnavailableReason(trader)).toBe('The trader history is incomplete.')
  })
})
