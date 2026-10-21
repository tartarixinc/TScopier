import { describe, expect, it } from 'vitest'
import { socialTraderStats, type SocialTrader } from './socialTradingFixture'

const trader: SocialTrader = {
  id: 'test', displayName: 'Test', username: 'test', isYou: false, access: 'open',
  monthlyCopyPriceCents: null, allowFollowing: true, roi: null, winRate: 50,
  maxDrawdown: null, closedTrades: 2, followerCount: 0, rating: null, ratingCount: 0,
  following: false, followsYou: false, previewBalance: null,
  profile: { joinedAt: null, rank: null, leverage: null, country: '', timezone: null },
  openTrades: [],
  closedPerformance: [
    { id: 'one', symbol: 'EURUSD', side: 'buy', openedAt: '2026-09-02T08:00:00Z', closedAt: '2026-09-02T12:00:00Z', profit: 120 },
    { id: 'two', symbol: 'USDJPY', side: 'sell', openedAt: '2026-09-03T08:00:00Z', closedAt: '2026-09-03T20:00:00Z', profit: -20 },
  ],
  activities: [], chart: { series: [], growth: [], outcome: [] },
}

describe('approved Social Trading performance presentation', () => {
  it('derives monthly and calendar P/L from the same closed trades', () => {
    const stats = socialTraderStats(trader)
    expect(stats.monthly.at(-1)).toEqual({ label: 'Sep', profit: 100 })
    expect(stats.calendar[1]).toEqual({ day: 2, profit: 120, trades: 1 })
    expect(stats.calendar[2]).toEqual({ day: 3, profit: -20, trades: 1 })
    expect(stats.profitableTrades).toBe(1)
    expect(stats.losingTrades).toBe(1)
    expect(stats.profitFactor).toBe(6)
  })

  it('keeps metrics unavailable when trade history cannot support them', () => {
    const stats = socialTraderStats(trader)
    expect(stats.sharpe).toBeNull()
    expect(stats.equity).toBeNull()
    expect(stats.deposit).toBeNull()
    expect(stats.dailyProfitPercent).toBeNull()
    expect(stats.monthlyProfitPercent).toBeNull()
  })
})
