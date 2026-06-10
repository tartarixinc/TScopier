import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  chartTradesQualityScore,
  deriveDashboardAnalytics,
  preferAuthoritativeChartTrades,
  resolveAnalyticsChartTrades,
} from './dashboardAnalytics'
import type { DashboardChartTrade } from './dashboardCharts'

const mtClosed: DashboardChartTrade = {
  brokerAccountId: 'b1',
  lotSize: 0.1,
  profit: 100,
  status: 'closed',
  closedAt: '2026-06-10T10:00:00',
  openedAt: '2026-06-10T09:00:00',
}

const dbClosedNullProfit: DashboardChartTrade = {
  brokerAccountId: 'b1',
  lotSize: 0.1,
  profit: null,
  status: 'closed',
  closedAt: '2026-06-10T10:00:00',
  openedAt: '2026-06-10T09:00:00',
}

test('chartTradesQualityScore counts only closed rows with finite profit', () => {
  assert.equal(chartTradesQualityScore([mtClosed, dbClosedNullProfit, { ...mtClosed, status: 'open' }]), 1)
})

test('preferAuthoritativeChartTrades: MT broker keeps prev when DB flash has null profits', () => {
  const prev = [mtClosed, { ...mtClosed, profit: 50 }]
  const next = [dbClosedNullProfit, dbClosedNullProfit, dbClosedNullProfit]
  const out = preferAuthoritativeChartTrades(prev, next, { hasMtBroker: true })
  assert.equal(out, prev)
})

test('preferAuthoritativeChartTrades: accepts MT refresh with higher quality', () => {
  const prev = [mtClosed]
  const next = [mtClosed, { ...mtClosed, profit: 200 }]
  const out = preferAuthoritativeChartTrades(prev, next, { hasMtBroker: true })
  assert.equal(out, next)
})

test('resolveAnalyticsChartTrades: MT broker ignores DB rows', () => {
  const db = [{
    broker_account_id: 'b1',
    lot_size: 0.1,
    profit: 999,
    status: 'closed',
    closed_at: '2026-06-10T10:00:00',
    opened_at: '2026-06-10T09:00:00',
  }]
  assert.equal(resolveAnalyticsChartTrades([], db, true).length, 0)
})

test('deriveDashboardAnalytics: today profit matches trade outcome bucket', () => {
  const now = new Date(2026, 5, 10, 12, 0, 0)
  const chartTrades: DashboardChartTrade[] = [
    {
      brokerAccountId: 'b1',
      lotSize: 0.1,
      profit: 400,
      status: 'closed',
      closedAt: '2026-06-10T10:00:00',
      openedAt: null,
    },
    {
      brokerAccountId: 'b1',
      lotSize: 0.1,
      profit: -59.39,
      status: 'closed',
      closedAt: '2026-06-10T11:00:00',
      openedAt: null,
    },
  ]
  const analytics = deriveDashboardAnalytics({
    chartTrades,
    mtTrades: [],
    channelLinkMaps: {
      ticketToChannelId: {},
      signalPrefixToChannelId: {},
      channelSlugToChannelId: {},
      channelNames: {},
    },
    unlinkedLabel: 'Unlinked',
    now,
  })
  assert.equal(analytics.todayProfit, 340.61)
  const todayBar = analytics.tradeVolume7Day.find(d => d.key === '2026-06-10')
  assert.ok(todayBar)
  assert.equal(todayBar!.profit - todayBar!.loss, analytics.todayProfit)
})
