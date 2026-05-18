import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  countClosedTradeOutcomesInRange,
  isTimestampInRange,
  netClosedLegProfit,
  sumClosedWinningProfitInRange,
  sumTradeableClosedProfitInRange,
} from './dashboardTradeStats'

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
