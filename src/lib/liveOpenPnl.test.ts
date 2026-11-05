import { describe, expect, it } from 'vitest'
import {
  describeLiveFetchError,
  liveOpenPnlFromMtTrades,
  liveOpenPnlFromOpenedOrders,
  liveOpenPnlFromSummary,
  preferLiveOpenPnl,
} from './liveOpenPnl'

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

describe('position-level live open P/L', () => {
  it('sums open MT trade profits', () => {
    expect(liveOpenPnlFromMtTrades([
      { status: 'open', profit: 12.5 } as never,
      { status: 'open', profit: -3 } as never,
      { status: 'closed', profit: 99 } as never,
    ])).toBe(9.5)
    expect(liveOpenPnlFromMtTrades([])).toBe(0)
  })

  it('sums opened-order position profits', () => {
    expect(liveOpenPnlFromOpenedOrders([
      { kind: 'position', profit: 10, swap: 1, commission: -0.5 },
      { kind: 'position', profit: -2 },
    ])).toBe(8.5)
  })

  it('prefers account summary over incomplete position sums (matches Linked Accounts)', () => {
    expect(preferLiveOpenPnl({ fromSummary: -1542, fromPositions: -677, openCount: 1 })).toBe(-1542)
    expect(preferLiveOpenPnl({ fromSummary: 4.5, fromPositions: null, openCount: 1 })).toBe(4.5)
  })

  it('falls back to positions only when the summary is missing or flat with opens', () => {
    expect(preferLiveOpenPnl({ fromSummary: 0, fromPositions: 18.25, openCount: 2 })).toBe(18.25)
    expect(preferLiveOpenPnl({ fromSummary: 0, fromPositions: null, openCount: 2 })).toBeNull()
    expect(preferLiveOpenPnl({ fromSummary: null, fromPositions: -12, openCount: 1 })).toBe(-12)
  })
})

describe('describeLiveFetchError', () => {
  it('explains an expired MT session', () => {
    expect(describeLiveFetchError('Client with id = abc-123 not found (:0)')).toMatch(/session .* expired/i)
  })

  it('explains rate limiting and passes other messages through', () => {
    expect(describeLiveFetchError('Too many requests')).toMatch(/rate limiting/i)
    expect(describeLiveFetchError('boom')).toBe('boom')
    expect(describeLiveFetchError('')).toMatch(/did not return/i)
  })
})
