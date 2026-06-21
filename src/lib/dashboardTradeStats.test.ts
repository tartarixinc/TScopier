import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  computeLinkedAccountPerformance,
  computeLinkedAccountPerformanceMap,
  countClosedTradeOutcomesInRange,
  isBalanceCashFlowRow,
  isTradeableClosedRow,
  isTradeableOpenRow,
  sumBalanceCashFlow,
  isTimestampInRange,
  netClosedLegProfit,
  sumClosedWinningProfitInRange,
  sumTradeableClosedProfitInRange,
} from './dashboardTradeStats'
import { summarizeTodayFromMtTrades } from './dashboardCharts'
import type { MtTrade } from './fxsocketBroker'

test('isTradeableClosedRow: excludes balance/deposit and zero-lot buy mislabels', () => {
  assert.equal(
    isTradeableClosedRow({
      status: 'closed',
      symbol: 'XAUUSD',
      lot_size: 0,
      direction: 'buy',
      type: 'Buy Stop Limit',
    }),
    false,
  )
  assert.equal(
    isTradeableClosedRow({
      status: 'closed',
      symbol: '',
      lot_size: 0,
      direction: '',
      type: 'Balance',
    }),
    false,
  )
  assert.equal(
    isTradeableClosedRow({
      status: 'closed',
      symbol: 'XAUUSD',
      lot_size: 0.1,
      direction: 'buy',
      type: 'Buy',
    }),
    true,
  )
})

test('isBalanceCashFlowRow: detects deposits and ignores tradeable closes', () => {
  assert.equal(
    isBalanceCashFlowRow({
      status: 'closed',
      symbol: '',
      lot_size: 0,
      direction: '',
      type: 'Balance',
      profit: 10_000,
    }),
    true,
  )
  assert.equal(
    isBalanceCashFlowRow({
      status: 'closed',
      symbol: '',
      lot_size: 0,
      direction: '',
      type: '',
      profit: 855.94,
    }),
    true,
  )
  assert.equal(
    isBalanceCashFlowRow({
      status: 'closed',
      symbol: 'XAUUSD',
      lot_size: 0.1,
      direction: 'buy',
      type: 'Buy',
      profit: 80,
    }),
    false,
  )
  assert.equal(
    sumBalanceCashFlow([
      {
        status: 'closed',
        symbol: '',
        lot_size: 0,
        type: 'Balance',
        profit: 10_000,
        closed_at: '2026-06-01',
      },
      {
        status: 'closed',
        symbol: 'XAUUSD',
        lot_size: 0.1,
        direction: 'buy',
        type: 'Buy',
        profit: 120,
        closed_at: '2026-06-02',
      },
    ]),
    10_000,
  )
})

test('isTradeableOpenRow: excludes balance and zero-lot open rows', () => {
  assert.equal(
    isTradeableOpenRow({
      status: 'open',
      symbol: 'XAUUSD',
      lot_size: 0,
      direction: 'buy',
      type: 'Buy Stop Limit',
    }),
    false,
  )
  assert.equal(
    isTradeableOpenRow({
      status: 'open',
      symbol: 'EURUSD',
      lot_size: 0.1,
      direction: 'sell',
      type: 'Sell',
    }),
    true,
  )
  assert.equal(
    isTradeableOpenRow({
      status: 'closed',
      symbol: 'EURUSD',
      lot_size: 0.1,
      direction: 'sell',
      type: 'Sell',
    }),
    false,
  )
})

test('summarizeTodayFromMtTrades: ignores MT4 balance top-up rows', () => {
  const now = new Date(2026, 5, 2, 12, 0, 0)
  const trades: MtTrade[] = [
    {
      id: 'a:1',
      broker_id: 'a',
      ticket: 1,
      symbol: 'XAUUSD',
      direction: 'buy',
      type: 'Buy Stop Limit',
      lot_size: 0,
      profit: 50_000,
      status: 'closed',
      closed_at: '2026-06-02T10:00:00',
      opened_at: '2026-06-02T10:00:00',
    },
    {
      id: 'a:2',
      broker_id: 'a',
      ticket: 2,
      symbol: 'XAUUSD',
      direction: 'buy',
      type: 'Buy',
      lot_size: 0.1,
      profit: 120,
      status: 'closed',
      closed_at: '2026-06-02T11:00:00',
      opened_at: '2026-06-02T09:00:00',
    },
  ]
  const s = summarizeTodayFromMtTrades(trades, now)
  assert.equal(s.hasData, true)
  assert.equal(s.taken, 1)
  assert.equal(s.netPnl, 120)
})

test('sumClosedWinningProfitInRange: sums only winning closed legs', () => {
  const rows = [
    {
      status: 'closed',
      symbol: 'XAUUSD',
      lot_size: 0.01,
      direction: 'buy',
      profit: 100,
      closed_at: '2026-05-16T12:00:00.000Z',
    },
    {
      status: 'closed',
      symbol: 'EURUSD',
      lot_size: 0.01,
      direction: 'sell',
      profit: -40,
      closed_at: '2026-05-16T13:00:00.000Z',
    },
    {
      status: 'closed',
      symbol: 'GBPUSD',
      lot_size: 0.01,
      direction: 'buy',
      profit: 25,
      closed_at: '2026-05-16T14:00:00.000Z',
    },
  ]
  assert.equal(sumClosedWinningProfitInRange(rows, () => true), 125)
  assert.equal(sumTradeableClosedProfitInRange(rows, () => true), 85)
})

test('sumTradeableClosedProfitInRange: includes swap and commission', () => {
  const rows = [
    {
      status: 'closed',
      symbol: 'XAUUSD',
      lot_size: 0.01,
      direction: 'buy',
      profit: 10,
      closed_at: '2026-05-16T12:00:00.000Z',
      swap: -1,
      commission: -0.5,
    },
  ]
  const sum = sumTradeableClosedProfitInRange(rows, () => true)
  assert.equal(sum, netClosedLegProfit(rows[0]!))
  assert.equal(sum, 8.5)
})

test('countClosedTradeOutcomesInRange: uses deal profit only (not commission)', () => {
  const rows = [
    {
      status: 'closed',
      symbol: 'XAUUSD',
      lot_size: 0.1,
      direction: 'buy',
      profit: 50,
      commission: -60,
      closed_at: '2026-05-16T12:00:00.000Z',
    },
    {
      status: 'closed',
      symbol: 'EURUSD',
      lot_size: 0.1,
      direction: 'sell',
      profit: -20,
      commission: -1,
      closed_at: '2026-05-16T13:00:00.000Z',
    },
    {
      status: 'closed',
      symbol: 'GBPUSD',
      lot_size: 0.1,
      direction: 'buy',
      profit: 0,
      closed_at: '2026-05-16T14:00:00.000Z',
    },
  ]
  const outcomes = countClosedTradeOutcomesInRange(rows, () => true)
  assert.equal(outcomes.taken, 3)
  assert.equal(outcomes.won, 1)
  assert.equal(outcomes.lost, 1)
  assert.equal(outcomes.breakeven, 1)
})

test('isTimestampInRange: half-open interval', () => {
  const start = new Date('2026-05-16T00:00:00.000Z')
  const end = new Date('2026-05-17T00:00:00.000Z')
  assert.equal(isTimestampInRange('2026-05-16T23:59:59.000Z', start, end), true)
  assert.equal(isTimestampInRange('2026-05-17T00:00:00.000Z', start, end), false)
})

test('computeLinkedAccountPerformance: ROI from realized trades ignores deposit-inflated equity', () => {
  const perf = computeLinkedAccountPerformance(
    { performance_baseline_balance: 10_000 },
    [
      {
        status: 'closed',
        symbol: 'XAUUSD',
        lot_size: 0.1,
        direction: 'buy',
        profit: 200,
        closed_at: '2026-05-16T12:00:00.000Z',
      },
    ],
    50_000,
  )
  assert.equal(perf.roi, 2)
})

test('computeLinkedAccountPerformanceMap: win rate and drawdown ignore pre-connect trades', () => {
  const account = {
    id: 'broker-1',
    performance_baseline_balance: 10_000,
    performance_baseline_captured_at: '2026-06-14T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  }
  const tradesByAccountId = {
    'broker-1': [
      {
        status: 'closed',
        symbol: 'XAUUSD',
        lot_size: 0.1,
        direction: 'buy',
        profit: -500,
        opened_at: '2026-06-01T10:00:00.000Z',
        closed_at: '2026-06-01T12:00:00.000Z',
      },
      {
        status: 'closed',
        symbol: 'XAUUSD',
        lot_size: 0.1,
        direction: 'buy',
        profit: 200,
        opened_at: '2026-06-15T10:00:00.000Z',
        closed_at: '2026-06-15T12:00:00.000Z',
      },
      {
        status: 'closed',
        symbol: 'EURUSD',
        lot_size: 0.1,
        direction: 'sell',
        profit: 100,
        opened_at: '2026-06-16T10:00:00.000Z',
        closed_at: '2026-06-16T12:00:00.000Z',
      },
    ],
  }

  const perf = computeLinkedAccountPerformanceMap([account], tradesByAccountId, {})['broker-1']
  assert.equal(perf?.winRate, 100)
  assert.equal(perf?.roi, 3)
  assert.equal(perf?.maxDrawdownPct, 0)
})
