import { describe, expect, it } from 'vitest'
import {
  acceptFreshOpenPnl,
  isAccountSummaryFlat,
  normalizeLiveOpenMetrics,
  resolveFlatBookOpenMetrics,
} from './dashboardLiveOpenMetrics'

describe('normalizeLiveOpenMetrics', () => {
  it('zeros PnL when there are no open trades', () => {
    expect(normalizeLiveOpenMetrics({ openTrades: 0, openPnl: 406.37 })).toEqual({
      openTrades: 0,
      openPnl: 0,
    })
  })

  it('keeps marked PnL while trades are open', () => {
    expect(normalizeLiveOpenMetrics({ openTrades: 10, openPnl: 268.61 })).toEqual({
      openTrades: 10,
      openPnl: 268.61,
    })
  })

  it('treats missing open count as flat', () => {
    expect(normalizeLiveOpenMetrics({ openTrades: null, openPnl: 12 })).toEqual({
      openTrades: 0,
      openPnl: 0,
    })
  })

  it('does not invent $0 PnL when opens exist but mark is unknown', () => {
    expect(normalizeLiveOpenMetrics({ openTrades: 104, openPnl: null })).toEqual({
      openTrades: 104,
      openPnl: null,
    })
    expect(normalizeLiveOpenMetrics({ openTrades: 4, openPnl: undefined })).toEqual({
      openTrades: 4,
      openPnl: null,
    })
  })
})

describe('resolveFlatBookOpenMetrics', () => {
  it('clears sticky opens when summary is flat and market book is empty', () => {
    expect(resolveFlatBookOpenMetrics({
      summaryFlat: true,
      marketOpenCount: 0,
      openPnl: 406,
    })).toEqual({ openTrades: 0, openPnl: 0 })
  })

  it('keeps market opens when summary is flat but positions remain', () => {
    expect(resolveFlatBookOpenMetrics({
      summaryFlat: true,
      marketOpenCount: 3,
      openPnl: null,
    })).toEqual({ openTrades: 3, openPnl: null })
  })

  it('uses market count when summary is not flat', () => {
    expect(resolveFlatBookOpenMetrics({
      summaryFlat: false,
      marketOpenCount: 12,
      openPnl: 55.5,
    })).toEqual({ openTrades: 12, openPnl: 55.5 })
  })
})

describe('isAccountSummaryFlat', () => {
  it('detects equity ≈ balance', () => {
    expect(isAccountSummaryFlat(45998.07, 45998.07)).toBe(true)
    expect(isAccountSummaryFlat(45998.07, 46266.68)).toBe(false)
    expect(isAccountSummaryFlat(null, 100)).toBe(false)
  })
})

describe('acceptFreshOpenPnl', () => {
  it('allows Open PnL to clear to zero', () => {
    expect(acceptFreshOpenPnl(406.37, 0)).toBe(0)
  })

  it('keeps previous when next is non-finite', () => {
    expect(acceptFreshOpenPnl(12, Number.NaN)).toBe(12)
  })
})
