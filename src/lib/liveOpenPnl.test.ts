import { describe, expect, it } from 'vitest'
import { liveOpenPnlFromSummary } from './liveOpenPnl'

describe('liveOpenPnlFromSummary', () => {
  it('uses the broker profit field', () => {
    expect(liveOpenPnlFromSummary({ balance: 1000, equity: 1042.5, profit: 42.5 }, 1)).toBe(42.5)
    expect(liveOpenPnlFromSummary({ balance: 1000, equity: 980, profit: -20 }, 2)).toBe(-20)
  })

  it('falls back to equity minus balance', () => {
    expect(liveOpenPnlFromSummary({ balance: 1000, equity: 1012.34 }, 1)).toBe(12.34)
  })

  it('is null without a summary or without enough data', () => {
    expect(liveOpenPnlFromSummary(null)).toBeNull()
    expect(liveOpenPnlFromSummary({})).toBeNull()
  })
})
