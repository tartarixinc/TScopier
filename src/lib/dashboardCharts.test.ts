import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { summarizeTodayFromChartTrades, type DashboardChartTrade } from './dashboardCharts'

test('summarizeTodayFromChartTrades: matches 7-day chart day bucket', () => {
  const now = new Date(2026, 4, 18, 15, 0, 0)
  const trades: DashboardChartTrade[] = [
    {
      brokerAccountId: 'a',
      lotSize: 0.1,
      profit: 100,
      status: 'closed',
      closedAt: '2026-05-18T10:00:00',
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
      closedAt: '2026-05-17T14:00:00',
      openedAt: null,
    },
  ]
  const s = summarizeTodayFromChartTrades(trades, now)
  assert.equal(s.hasData, true)
  assert.equal(s.taken, 2)
  assert.equal(s.won, 1)
  assert.equal(s.lost, 1)
  assert.equal(s.netPnl, 70)
})
