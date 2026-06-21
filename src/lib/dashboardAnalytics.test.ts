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

test('preferAuthoritativeChartTrades: MT broker accepts DB seed when prev empty', () => {
  const prev: DashboardChartTrade[] = []
  const next = [dbClosedNullProfit, dbClosedNullProfit]
  const out = preferAuthoritativeChartTrades(prev, next, { hasMtBroker: true })
  assert.equal(out, next)
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

test('resolveAnalyticsChartTrades: MT broker falls back to DB when MT snapshot empty', () => {
  const db = [{
    broker_account_id: 'b1',
    lot_size: 0.1,
    profit: 999,
    status: 'closed',
    closed_at: '2026-06-10T10:00:00',
    opened_at: '2026-06-10T09:00:00',
  }]
  assert.equal(resolveAnalyticsChartTrades([], db, true).length, 1)
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
      ticketToSignalId: {},
      signalPrefixToChannelId: {},
      signalPrefixToSignalId: {},
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

test('deriveDashboardAnalytics: MT trades drive today and yesterday profit', () => {
  const now = new Date(2026, 5, 10, 12, 0, 0)
  const maps = {
    ticketToChannelId: { 'b1:1': 'ch-1', 'b1:2': 'ch-1' },
    ticketToSignalId: {},
    signalPrefixToChannelId: {},
    signalPrefixToSignalId: {},
    channelSlugToChannelId: {},
    channelNames: { 'ch-1': 'VIP Gold' },
  }
  const mtTrades = [
    {
      id: 'b1:1',
      broker_id: 'b1',
      broker_label: 'Demo',
      broker_name: 'IC',
      ticket: 1,
      symbol: 'XAUUSD',
      direction: 'buy' as const,
      type: 'Buy',
      lot_size: 0.1,
      entry_price: 2500,
      sl: null,
      tp: null,
      close_price: 2510,
      profit: 120,
      swap: 0,
      commission: 0,
      comment: null,
      magic: null,
      opened_at: '2026-06-10T09:00:00',
      closed_at: '2026-06-10T10:00:00',
      state: null,
      status: 'closed' as const,
    },
    {
      id: 'b1:2',
      broker_id: 'b1',
      broker_label: 'Demo',
      broker_name: 'IC',
      ticket: 2,
      symbol: 'XAUUSD',
      direction: 'buy' as const,
      type: 'Buy',
      lot_size: 0.1,
      entry_price: 2500,
      sl: null,
      tp: null,
      close_price: 2490,
      profit: -40,
      swap: 0,
      commission: 0,
      comment: null,
      magic: null,
      opened_at: '2026-06-09T09:00:00',
      closed_at: '2026-06-09T15:00:00',
      state: null,
      status: 'closed' as const,
    },
  ]
  const analytics = deriveDashboardAnalytics({
    chartTrades: [],
    mtTrades,
    channelLinkMaps: maps,
    unlinkedLabel: 'Unlinked',
    now,
  })
  assert.equal(analytics.todayProfit, 120)
  assert.equal(analytics.yesterdayProfit, -40)
  assert.equal(analytics.tradesTaken, 1)
  assert.equal(analytics.tradesTakenYesterday, 1)
})

test('deriveDashboardAnalytics: excludes manual MT trades without channel attribution', () => {
  const now = new Date(2026, 5, 10, 12, 0, 0)
  const maps = {
    ticketToChannelId: { 'b1:1': 'ch-1' },
    ticketToSignalId: {},
    signalPrefixToChannelId: {},
    signalPrefixToSignalId: {},
    channelSlugToChannelId: {},
    channelNames: { 'ch-1': 'VIP Gold' },
  }
  const mtTrades = [
    {
      id: 'b1:1',
      broker_id: 'b1',
      broker_label: 'Demo',
      broker_name: 'IC',
      ticket: 1,
      symbol: 'XAUUSD',
      direction: 'buy' as const,
      type: 'Buy',
      lot_size: 0.1,
      entry_price: 2500,
      sl: null,
      tp: null,
      close_price: 2510,
      profit: 120,
      swap: 0,
      commission: 0,
      comment: null,
      magic: null,
      opened_at: '2026-06-10T09:00:00',
      closed_at: '2026-06-10T10:00:00',
      state: null,
      status: 'closed' as const,
    },
    {
      id: 'b1:2',
      broker_id: 'b1',
      broker_label: 'Demo',
      broker_name: 'IC',
      ticket: 2,
      symbol: 'XAUUSD',
      direction: 'buy' as const,
      type: 'Buy',
      lot_size: 0.1,
      entry_price: 2500,
      sl: null,
      tp: null,
      close_price: 2490,
      profit: 500,
      swap: 0,
      commission: 0,
      comment: null,
      magic: null,
      opened_at: '2026-06-10T09:00:00',
      closed_at: '2026-06-10T11:00:00',
      state: null,
      status: 'closed' as const,
    },
  ]
  const analytics = deriveDashboardAnalytics({
    chartTrades: [],
    mtTrades,
    channelLinkMaps: maps,
    unlinkedLabel: 'Unlinked',
    now,
  })
  assert.equal(analytics.todayProfit, 120)
  assert.equal(analytics.tradesTaken, 1)
})

test('deriveDashboardAnalytics: attributes TScopier comment via account connected channels', () => {
  const now = new Date(2026, 5, 14, 12, 0, 0)
  const channelId = 'ch-test-1'
  const maps = {
    ticketToChannelId: {},
    ticketToSignalId: {},
    signalPrefixToChannelId: {},
    signalPrefixToSignalId: {},
    channelSlugToChannelId: { testsignalch: channelId },
    channelNames: { [channelId]: 'Test Signal Channel' },
  }
  const mtTrades = [{
    id: 'b1:1',
    broker_id: 'b1',
    broker_label: 'Demo',
    broker_name: 'IC',
    ticket: 1,
    symbol: 'BTCUSD',
    direction: 'buy' as const,
    type: 'Buy',
    lot_size: 0.1,
    entry_price: 100000,
    sl: null,
    tp: null,
    close_price: 101000,
    profit: 100,
    swap: 0,
    commission: 0,
    comment: 'TScopier:TestSignalCh:4a6c0a6b',
    magic: null,
    opened_at: '2026-06-14T09:00:00',
    closed_at: '2026-06-14T10:00:00',
    state: null,
    status: 'closed' as const,
  }]
  const analytics = deriveDashboardAnalytics({
    chartTrades: [],
    mtTrades,
    channelLinkMaps: maps,
    unlinkedLabel: 'Unlinked',
    accounts: [{
      id: 'b1',
      performance_baseline_captured_at: '2026-06-14T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      signal_channel_ids: [channelId],
    }],
    now,
  })
  assert.equal(analytics.todayProfit, 100)
  assert.equal(analytics.tradesTaken, 1)
})

test('deriveDashboardAnalytics: excludes pre-connect chart trades when broker linked', () => {
  const now = new Date(2026, 5, 14, 12, 0, 0)
  const chartTrades: DashboardChartTrade[] = [
    {
      brokerAccountId: 'b1',
      lotSize: 0.1,
      profit: 500,
      status: 'closed',
      closedAt: '2026-06-01T10:00:00',
      openedAt: '2026-06-01T09:00:00',
    },
    {
      brokerAccountId: 'b1',
      lotSize: 0.1,
      profit: 50,
      status: 'closed',
      closedAt: '2026-06-14T10:00:00',
      openedAt: '2026-06-14T09:00:00',
    },
  ]
  const analytics = deriveDashboardAnalytics({
    chartTrades,
    mtTrades: [],
    channelLinkMaps: {
      ticketToChannelId: {},
      ticketToSignalId: {},
      signalPrefixToChannelId: {},
      signalPrefixToSignalId: {},
      channelSlugToChannelId: {},
      channelNames: {},
    },
    unlinkedLabel: 'Unlinked',
    accounts: [{
      id: 'b1',
      performance_baseline_captured_at: '2026-06-14T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    }],
    now,
  })
  assert.equal(analytics.todayProfit, 50)
  assert.equal(analytics.tradeVolume7Day.reduce((sum, d) => sum + d.volume, 0), 1)
})

test('deriveDashboardAnalytics: empty 7d charts when MT loaded but all pre-connect', () => {
  const now = new Date(2026, 5, 14, 12, 0, 0)
  const maps = {
    ticketToChannelId: { 'b1:1': 'ch-1' },
    ticketToSignalId: {},
    signalPrefixToChannelId: {},
    signalPrefixToSignalId: {},
    channelSlugToChannelId: {},
    channelNames: { 'ch-1': 'VIP Gold' },
  }
  const mtTrades = [{
    id: 'b1:1',
    broker_id: 'b1',
    broker_label: 'Demo',
    broker_name: 'IC',
    ticket: 1,
    symbol: 'XAUUSD',
    direction: 'buy' as const,
    type: 'Buy',
    lot_size: 0.1,
    entry_price: 2500,
    sl: null,
    tp: null,
    close_price: 2510,
    profit: 500,
    swap: 0,
    commission: 0,
    comment: null,
    magic: null,
    opened_at: '2026-06-01T09:00:00',
    closed_at: '2026-06-01T10:00:00',
    state: null,
    status: 'closed' as const,
  }]
  const staleChart: DashboardChartTrade[] = [{
    brokerAccountId: 'b1',
    lotSize: 0.1,
    profit: 999,
    status: 'closed',
    closedAt: '2026-06-01T10:00:00',
    openedAt: '2026-06-01T09:00:00',
  }]
  const analytics = deriveDashboardAnalytics({
    chartTrades: staleChart,
    mtTrades,
    channelLinkMaps: maps,
    unlinkedLabel: 'Unlinked',
    accounts: [{
      id: 'b1',
      performance_baseline_captured_at: '2026-06-14T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    }],
    now,
  })
  assert.equal(analytics.todayProfit, 0)
  assert.equal(analytics.tradeVolume7Day.reduce((sum, d) => sum + d.volume, 0), 0)
  assert.equal(analytics.channelProfit7d.length, 0)
})
