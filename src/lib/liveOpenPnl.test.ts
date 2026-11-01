import { describe, expect, it } from 'vitest'
import { describeLiveFetchError, liveOpenPnlFromSummary } from './liveOpenPnl'

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
