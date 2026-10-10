import { describe, expect, it } from 'vitest'
import { estimateSocialCopyLot } from './socialCopyPreview'

describe('estimateSocialCopyLot', () => {
  it('scales a trader lot by the destination-to-source balance ratio', () => {
    expect(estimateSocialCopyLot({
      mode: 'proportional',
      traderLot: 1,
      traderBalance: 25_000,
      destinationBalance: 4_500,
      fixedLot: 0.1,
      multiplier: 1,
    })).toBe(0.18)
  })

  it('uses the requested fixed lot without requiring balances', () => {
    expect(estimateSocialCopyLot({
      mode: 'fixed_lot',
      traderLot: 1,
      traderBalance: null,
      destinationBalance: null,
      fixedLot: 0.1,
      multiplier: 1,
    })).toBe(0.1)
  })

  it('applies the selected multiplier to the trader lot', () => {
    expect(estimateSocialCopyLot({
      mode: 'risk_multiplier',
      traderLot: 0.4,
      traderBalance: null,
      destinationBalance: null,
      fixedLot: 0.1,
      multiplier: 0.75,
    })).toBe(0.3)
  })

  it('does not invent a proportional lot when a balance is unavailable', () => {
    expect(estimateSocialCopyLot({
      mode: 'proportional',
      traderLot: 1,
      traderBalance: 25_000,
      destinationBalance: null,
      fixedLot: 0.1,
      multiplier: 1,
    })).toBeNull()
  })
})
