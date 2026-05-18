import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildTradeVolumeByDays, sumNetPnlFromTradeVolumeDays } from './dashboardCharts'
import {
  computePeriodStatsFromChartTrades,
  computePeriodStatsFromVolumeBuckets,
} from './performanceAnalytics'
import type { DashboardChartTrade } from './dashboardCharts'

const trades: DashboardChartTrade[] = [
  {
    brokerAccountId: 'a',
    lotSize: 0.1,
    profit: 100,
    status: 'closed',
    closedAt: '2026-05-16T10:00:00',
    openedAt: null,
  },
  {
    brokerAccountId: 'a',
    lotSize: 0.1,
    profit: -30,
    status: 'closed',
    closedAt: '2026-05-18T14:00:00',
    openedAt: null,
  },
  {
    brokerAccountId: 'a',
    lotSize: 0.1,
    profit: 50,
    status: 'closed',
    closedAt: '2026-05-10T09:00:00',
    openedAt: null,
  },
]

test('period realized P/L equals sum of Trade Outcome chart buckets', () => {
  const now = new Date(2026, 4, 18, 12, 0, 0)
  const buckets = buildTradeVolumeByDays(trades, 7, now)
  const chartNet = sumNetPnlFromTradeVolumeDays(buckets)
  const stats = computePeriodStatsFromChartTrades(trades, '7d', now)
  assert.equal(stats.realizedPnl, chartNet)
  assert.equal(stats.realizedPnl, 70)
})

test('computePeriodStatsFromVolumeBuckets matches chart buckets', () => {
  const now = new Date(2026, 4, 18, 12, 0, 0)
  const buckets = buildTradeVolumeByDays(trades, 30, now)
  const stats = computePeriodStatsFromVolumeBuckets(trades, buckets)
  assert.equal(stats.realizedPnl, sumNetPnlFromTradeVolumeDays(buckets))
})

test('trades outside period buckets are excluded from stats', () => {
  const now = new Date(2026, 4, 18, 12, 0, 0)
  const buckets = buildTradeVolumeByDays(trades, 7, now)
  const stats = computePeriodStatsFromVolumeBuckets(trades, buckets)
  assert.equal(stats.tradesTaken, 2)
})
