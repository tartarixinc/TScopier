import assert from 'node:assert/strict'
import test from 'node:test'
import { performanceMetricsReconcile, summarizeSocialTradesByDay } from './socialPerformancePresentation'
import type { SocialTradeHistoryItem } from './socialTradeHistory'

const trades: SocialTradeHistoryItem[] = [
  { tradeId: 'win', symbol: 'EURUSD', direction: 'buy', status: 'closed', openedAt: '2026-10-01T00:00:00Z', closedAt: '2026-10-02T01:00:00Z', realizedProfit: 100 },
  { tradeId: 'loss', symbol: 'XAUUSD', direction: 'sell', status: 'closed', openedAt: '2026-10-01T00:00:00Z', closedAt: '2026-10-02T02:00:00Z', realizedProfit: -40 },
  { tradeId: 'flat', symbol: 'GBPUSD', direction: 'buy', status: 'closed', openedAt: '2026-10-03T00:00:00Z', closedAt: '2026-10-03T01:00:00Z', realizedProfit: 0 },
  { tradeId: 'open', symbol: 'USDJPY', direction: 'buy', status: 'open', openedAt: '2026-10-04T00:00:00Z', closedAt: null, realizedProfit: null },
]

test('reconciles supported metrics from complete closed source trades', () => {
  const metrics = performanceMetricsReconcile(trades)
  assert.deepEqual({ ...metrics, winRate: Number(metrics.winRate?.toFixed(6)) }, {
    closedTradeCount: 3,
    realizedProfit: 60,
    winRate: 33.333333,
    profitFactor: 2.5,
  })
})

test('builds daily P/L from closed results without inventing an equity curve', () => {
  assert.deepEqual(summarizeSocialTradesByDay(trades), [
    { key: '2026-10-02', profit: 60, tradeCount: 2 },
    { key: '2026-10-03', profit: 0, tradeCount: 1 },
  ])
})
