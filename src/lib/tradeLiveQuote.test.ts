import { describe, expect, it } from 'vitest'
import {
  formatBidAskLine,
  liveExitPrice,
  normalizeTradeQuote,
  shouldPollTradeQuote,
} from './tradeLiveQuote'

describe('normalizeTradeQuote', () => {
  it('reads numeric bid/ask and keeps symbol/time', () => {
    expect(normalizeTradeQuote({ bid: 4290.1, ask: 4290.3, symbol: 'XAUUSD', time: '12:00:00' })).toEqual({
      bid: 4290.1,
      ask: 4290.3,
      symbol: 'XAUUSD',
      time: '12:00:00',
    })
  })

  it('coerces string prices and drops zero/invalid sides', () => {
    expect(normalizeTradeQuote({ bid: '1.0912', ask: 0, time: 1727160000 })).toEqual({
      bid: 1.0912,
      ask: null,
      time: '1727160000',
    })
  })

  it('returns null when there is no usable price', () => {
    expect(normalizeTradeQuote(null)).toBeNull()
    expect(normalizeTradeQuote({})).toBeNull()
    expect(normalizeTradeQuote({ bid: 0, ask: -1 })).toBeNull()
    expect(normalizeTradeQuote('1.1')).toBeNull()
  })
})

describe('shouldPollTradeQuote', () => {
  const base = { id: 't1', status: 'open' as const, symbol: 'XAUUSD', broker_id: 'b1', direction: 'buy' }

  it('allows open trades with broker and symbol', () => {
    expect(shouldPollTradeQuote(base)).toBe(true)
  })

  it('skips closed, missing broker, missing symbol, and null trade', () => {
    expect(shouldPollTradeQuote({ ...base, status: 'closed' })).toBe(false)
    expect(shouldPollTradeQuote({ ...base, broker_id: '' })).toBe(false)
    expect(shouldPollTradeQuote({ ...base, symbol: '  ' })).toBe(false)
    expect(shouldPollTradeQuote(null)).toBe(false)
  })
})

describe('liveExitPrice', () => {
  const quote = { bid: 100, ask: 101, symbol: 'T', time: undefined }

  it('uses bid for buy and ask for sell', () => {
    expect(liveExitPrice('buy', quote)).toBe(100)
    expect(liveExitPrice('SELL', quote)).toBe(101)
  })

  it('falls back to the available side', () => {
    expect(liveExitPrice('buy', { bid: null, ask: 50, symbol: 'T', time: undefined })).toBe(50)
    expect(liveExitPrice('sell', { bid: 40, ask: null, symbol: 'T', time: undefined })).toBe(40)
    expect(liveExitPrice('buy', null)).toBeNull()
  })
})

describe('formatBidAskLine', () => {
  it('formats both sides or a single side', () => {
    expect(formatBidAskLine({ bid: 1.1, ask: 1.2, symbol: 'E', time: undefined })).toBe('1.10000 / 1.20000')
    expect(formatBidAskLine({ bid: null, ask: 4290.25, symbol: 'X', time: undefined })).toBe('4290.25000')
    expect(formatBidAskLine({ bid: null, ask: null, symbol: 'X', time: undefined })).toBeNull()
  })
})
