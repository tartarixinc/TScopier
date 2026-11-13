import { describe, expect, it } from 'vitest'
import { acceptFreshOpenPnl, normalizeLiveOpenMetrics } from './dashboardLiveOpenMetrics'

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
})

describe('acceptFreshOpenPnl', () => {
  it('allows Open PnL to clear to zero', () => {
    expect(acceptFreshOpenPnl(406.37, 0)).toBe(0)
  })

  it('keeps previous when next is non-finite', () => {
    expect(acceptFreshOpenPnl(12, Number.NaN)).toBe(12)
  })
})
