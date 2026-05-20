import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildTradeVolume7Day,
  findTodayTradeOutcomeDay,
  findYesterdayTradeOutcomeDay,
  netPnlFromTradeOutcomeDay,
  summarizeTodayFromChartTrades,
  buildAccountGrowthSeries,
  closedTradeDayKey,
  sumClosedDealProfitByBroker,
  sumNetPnlFromTradeVolumeDays,
  buildTradeVolumeByDays,
  type DashboardChartTrade,
} from './dashboardCharts'

test('closedTradeDayKey: naive MT datetime uses local calendar day', () => {
  assert.equal(closedTradeDayKey('2026-05-18T22:30:00'), '2026-05-18')
})

test('closedTradeDayKey: unix seconds and ISO from API', () => {
  const keyFromSeconds = closedTradeDayKey(1_748_275_200)
  assert.ok(keyFromSeconds)
  assert.equal(closedTradeDayKey('2026-05-18T10:00:00.000Z'), closedTradeDayKey('2026-05-18T10:00:00.000Z'))
})

test('sumNetPnlFromTradeVolumeDays matches per-deal sum in window', () => {
  const now = new Date(2026, 4, 18, 12, 0, 0)
  const trades: DashboardChartTrade[] = [
    {
      brokerAccountId: 'a',
      lotSize: 0.1,
      profit: 40,
      status: 'closed',
      closedAt: '2026-05-17T10:00:00',
      openedAt: null,
    },
    {
      brokerAccountId: 'a',
      lotSize: 0.1,
      profit: -10,
      status: 'closed',
      closedAt: '2026-05-18T10:00:00',
      openedAt: null,
    },
  ]
  const buckets = buildTradeVolumeByDays(trades, 7, now)
  assert.equal(sumNetPnlFromTradeVolumeDays(buckets), 30)
})

test('buildAccountGrowthSeries: balance = opening + cumulative closed P/L', () => {
  const now = new Date(2026, 4, 18, 12, 0, 0)
  const trades: DashboardChartTrade[] = [
    {
      brokerAccountId: 'acc-1',
      lotSize: 0.1,
      profit: 50,
      status: 'closed',
      closedAt: '2026-05-16T10:00:00',
      openedAt: null,
    },
    {
      brokerAccountId: 'acc-1',
      lotSize: 0.1,
      profit: -20,
      status: 'closed',
      closedAt: '2026-05-18T10:00:00',
      openedAt: null,
    },
    {
      brokerAccountId: 'acc-2',
      lotSize: 0.1,
      profit: 10,
      status: 'closed',
      closedAt: '2026-05-18T11:00:00',
      openedAt: null,
    },
  ]
  const accounts = [
    { id: 'acc-1', is_active: true, broker_name: 'A' },
    { id: 'acc-2', is_active: true, broker_name: 'B' },
  ] as Parameters<typeof buildAccountGrowthSeries>[0]
  const balances = { 'acc-1': 1030, 'acc-2': 1010 }
  const { data, series } = buildAccountGrowthSeries(accounts, trades, balances, 7, now)
  assert.equal(series.length, 2)
  assert.equal(data.length, 7)
  const may16 = data.find(r => r.key === '2026-05-16')!
  const last = data[data.length - 1]!
  assert.equal(may16.acc_acc1, 1050)
  assert.equal(last.acc_acc1, 1030)
  assert.equal(last.acc_acc2, 1010)
})

test('sumClosedDealProfitByBroker: sums closed deal profit per broker', () => {
  const trades: DashboardChartTrade[] = [
    { brokerAccountId: 'a', lotSize: 0.1, profit: 100, status: 'closed', closedAt: '2026-01-01', openedAt: null },
    { brokerAccountId: 'a', lotSize: 0.1, profit: -20, status: 'closed', closedAt: '2026-02-01', openedAt: null },
    { brokerAccountId: 'b', lotSize: 0.1, profit: 50, status: 'closed', closedAt: '2026-01-15', openedAt: null },
    { brokerAccountId: 'a', lotSize: 0.1, profit: 10, status: 'open', closedAt: null, openedAt: null },
  ]
  const sums = sumClosedDealProfitByBroker(trades)
  assert.equal(sums.a, 80)
  assert.equal(sums.b, 50)
})

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

test('netPnlFromTradeOutcomeDay matches buildTradeVolume7Day today bucket', () => {
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
  ]
  const bucket = findTodayTradeOutcomeDay(trades, now)!
  const week = buildTradeVolume7Day(trades, now)
  const today = week.find(d => d.key === bucket.key)!
  assert.equal(netPnlFromTradeOutcomeDay(today), 70)
  assert.equal(today.profit, 100)
  assert.equal(today.loss, 30)
})

test('findYesterdayTradeOutcomeDay: net is profit minus loss', () => {
  const now = new Date(2026, 4, 19, 12, 0, 0)
  const trades: DashboardChartTrade[] = [
    {
      brokerAccountId: 'a',
      lotSize: 0.1,
      profit: 200,
      status: 'closed',
      closedAt: '2026-05-18T10:00:00',
      openedAt: null,
    },
    {
      brokerAccountId: 'a',
      lotSize: 0.1,
      profit: -50,
      status: 'closed',
      closedAt: '2026-05-18T14:00:00',
      openedAt: null,
    },
  ]
  const bucket = findYesterdayTradeOutcomeDay(trades, now)!
  assert.equal(netPnlFromTradeOutcomeDay(bucket), 150)
  assert.equal(bucket.profit, 200)
  assert.equal(bucket.loss, 50)
})
