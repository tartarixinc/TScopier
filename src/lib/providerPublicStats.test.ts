import { describe, expect, it } from 'vitest'
import type { ProviderPublicTrade } from './providerPublicProfile'
import { computePublicTradeStats, formatHolding } from './providerPublicStats'

const trade = (id: string, symbol: string, direction: 'buy' | 'sell', openedAt: string, closedAt: string | null, profit: number | null): ProviderPublicTrade => ({
  tradeId: id, symbol, direction, status: closedAt ? 'closed' : 'open', openedAt, closedAt, realizedProfit: profit,
})

const trades = [
  trade('1', 'EURUSD', 'buy', '2026-10-01T08:00:00Z', '2026-10-01T10:00:00Z', 100),
  trade('2', 'EURUSD', 'sell', '2026-10-02T08:00:00Z', '2026-10-02T09:00:00Z', -40),
  trade('3', 'XAUUSD', 'buy', '2026-10-03T08:00:00Z', '2026-10-03T12:00:00Z', 60),
  trade('4', 'XAUUSD', 'buy', '2026-10-04T08:00:00Z', '2026-10-04T08:30:00Z', -20),
  trade('5', 'XAUUSD', 'sell', '2026-10-05T08:00:00Z', null, null),
]

describe('computePublicTradeStats', () => {
  it('summarises closed trades and ignores open ones', () => {
    const stats = computePublicTradeStats(trades)
    expect(stats.closedTrades).toBe(4)
    expect(stats.wins).toBe(2)
    expect(stats.losses).toBe(2)
    expect(stats.longTrades).toBe(3)
    expect(stats.shortTrades).toBe(1)
    expect(stats.longWinRate).toBeCloseTo(66.67, 1)
    expect(stats.shortWinRate).toBe(0)
    expect(stats.avgProfit).toBe(25)
    expect(stats.avgWin).toBe(80)
    expect(stats.avgLoss).toBe(-30)
    expect(stats.avgHoldingHours).toBe(1.88)
    expect(stats.bestStreak).toBe(1)
    expect(stats.worstStreak).toBe(1)
  })

  it('breaks results down by symbol and builds a cumulative curve in closing order', () => {
    const stats = computePublicTradeStats([...trades].reverse())
    expect(stats.symbols.map(row => [row.symbol, row.trades, row.profit])).toEqual([['EURUSD', 2, 60], ['XAUUSD', 2, 40]])
    expect(stats.curve.map(point => point.cumulative)).toEqual([100, 60, 120, 100])
  })

  it('returns empty values when there is no closed history', () => {
    const stats = computePublicTradeStats([trades[4]])
    expect(stats.closedTrades).toBe(0)
    expect(stats.avgProfit).toBeNull()
    expect(stats.curve).toEqual([])
  })

  it('formats holding time', () => {
    expect(formatHolding(null)).toBe('\u2014')
    expect(formatHolding(0.5)).toBe('30 min')
    expect(formatHolding(5)).toBe('5.0 h')
    expect(formatHolding(72)).toBe('3.0 days')
  })
})
