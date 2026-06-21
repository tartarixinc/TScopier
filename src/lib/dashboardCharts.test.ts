import { describe, test, expect } from 'vitest'
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
  expect(closedTradeDayKey('2026-05-18T22:30:00')).toBe('2026-05-18')
})

test('closedTradeDayKey: unix seconds and ISO from API', () => {
  const keyFromSeconds = closedTradeDayKey(1_748_275_200)
  expect(keyFromSeconds).toBeTruthy()
  expect(closedTradeDayKey('2026-05-18T10:00:00.000Z')).toBe(closedTradeDayKey('2026-05-18T10:00:00.000Z'))
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
  expect(sumNetPnlFromTradeVolumeDays(buckets)).toBe(30)
})

const SESSION_UUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'

test('buildAccountGrowthSeries: flat balance line when no closed trades in window', () => {
  const now = new Date(2026, 4, 18, 12, 0, 0)
  const accounts = [
    { id: 'acc-1', is_active: true, broker_name: 'Demo', fxsocket_account_id: SESSION_UUID },
  ] as Parameters<typeof buildAccountGrowthSeries>[0]
  const balances = { 'acc-1': 5000 }
  const { data, series } = buildAccountGrowthSeries(accounts, [], balances, 7, now)
  expect(series.length).toBe(1)
  expect(data.length).toBe(7)
  for (const row of data) {
    expect(row.acc_acc1).toBe(5000)
  }
})

test('buildAccountGrowthSeries: backfills balance from closed trades in window', () => {
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
  ]
  const accounts = [
    { id: 'acc-1', is_active: true, broker_name: 'Demo', fxsocket_account_id: SESSION_UUID },
  ] as Parameters<typeof buildAccountGrowthSeries>[0]
  const balances = { 'acc-1': 5000 }
  const { data, series } = buildAccountGrowthSeries(accounts, trades, balances, 7, now)
  expect(series.length).toBe(1)
  expect(data.length).toBe(7)
  const may16 = data.find(r => r.key === '2026-05-16')!
  const last = data[data.length - 1]!
  expect(may16.acc_acc1).toBe(5050)
  expect(last.acc_acc1).toBe(5000)
})

test('buildAccountGrowthSeries: includes copy-paused session-linked accounts', () => {
  const now = new Date(2026, 4, 18, 12, 0, 0)
  const accounts = [
    { id: 'acc-1', is_active: false, broker_name: 'Paused', fxsocket_account_id: SESSION_UUID },
  ] as Parameters<typeof buildAccountGrowthSeries>[0]
  const balances = { 'acc-1': 2500 }
  const { series } = buildAccountGrowthSeries(accounts, [], balances, 7, now)
  expect(series.length).toBe(1)
})

test('buildAccountGrowthSeries: reconstructs per-account balance from closed deals', () => {
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
    { id: 'acc-1', is_active: true, broker_name: 'A', fxsocket_account_id: SESSION_UUID },
    { id: 'acc-2', is_active: true, broker_name: 'B', fxsocket_account_id: 'b2b2b2b2-b2b2-4789-a012-3456789abcde' },
  ] as Parameters<typeof buildAccountGrowthSeries>[0]
  const balances = { 'acc-1': 1030, 'acc-2': 1010 }
  const { data, series } = buildAccountGrowthSeries(accounts, trades, balances, 7, now)
  expect(series.length).toBe(2)
  expect(data.length).toBe(7)
  const may16 = data.find(r => r.key === '2026-05-16')!
  const last = data[data.length - 1]!
  expect(may16.acc_acc1).toBe(1050)
  expect(last.acc_acc1).toBe(1030)
  expect(last.acc_acc2).toBe(1010)
})

test('sumClosedDealProfitByBroker: sums closed deal profit per broker', () => {
  const trades: DashboardChartTrade[] = [
    { brokerAccountId: 'a', lotSize: 0.1, profit: 100, status: 'closed', closedAt: '2026-01-01', openedAt: null },
    { brokerAccountId: 'a', lotSize: 0.1, profit: -20, status: 'closed', closedAt: '2026-02-01', openedAt: null },
    { brokerAccountId: 'b', lotSize: 0.1, profit: 50, status: 'closed', closedAt: '2026-01-15', openedAt: null },
    { brokerAccountId: 'a', lotSize: 0.1, profit: 10, status: 'open', closedAt: null, openedAt: null },
  ]
  const sums = sumClosedDealProfitByBroker(trades)
  expect(sums.a).toBe(80)
  expect(sums.b).toBe(50)
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
  expect(s.hasData).toBe(true)
  expect(s.taken).toBe(2)
  expect(s.won).toBe(1)
  expect(s.lost).toBe(1)
  expect(s.netPnl).toBe(70)
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
  expect(netPnlFromTradeOutcomeDay(today)).toBe(70)
  expect(today.profit).toBe(100)
  expect(today.loss).toBe(30)
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
  expect(netPnlFromTradeOutcomeDay(bucket)).toBe(150)
  expect(bucket.profit).toBe(200)
  expect(bucket.loss).toBe(50)
})
