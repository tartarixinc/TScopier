import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  adjustMtTradesPositionDirection,
  flattenMtOrder,
  mergeMtHistoryRow,
  resolveMtDealProfit,
  resolveMtLots,
} from './mtTradeFields'

test('resolveMtLots: MT5 integer volume and explicit lots', () => {
  assert.equal(resolveMtLots({ volume: 100 }, 'dashboard'), 0.01)
  assert.equal(resolveMtLots({ Volume: 10000 }, 'trades'), 1)
  assert.equal(resolveMtLots({ lots: 0.05 }, 'dashboard'), 0.05)
})

test('trades profile: reads lots and profit from dealInternalOut when top-level is zero', () => {
  const row = {
    ticket: 999,
    symbol: 'EURUSD',
    volume: 0,
    profit: 0,
    lots: 0,
    dealInternalOut: {
      ticketNumber: 999,
      lots: 0.12,
      profit: 87.4,
      volume: 0,
    },
  }
  const flat = flattenMtOrder(row, 'trades')
  assert.equal(resolveMtLots(flat, 'trades'), 0.12)
  assert.equal(resolveMtDealProfit(flat, 'trades'), 87.4)
})

test('dashboard profile: does not copy dealInternalOut profit onto top-level row', () => {
  const row = {
    ticket: 999,
    symbol: 'EURUSD',
    volume: 0,
    profit: 0,
    lots: 0.1,
    dealInternalOut: { lots: 0.12, profit: 87.4 },
  }
  assert.equal(resolveMtDealProfit(row, 'dashboard'), 0)
  assert.equal(resolveMtLots(row, 'dashboard'), 0.1)
})

test('resolveMtLots: closeLots on closed order (trades)', () => {
  assert.equal(resolveMtLots({ volume: 0, closeLots: 0.25 }, 'trades'), 0.25)
})

test('adjustMtTradesPositionDirection: closing sell position uses sell not exit buy deal', () => {
  const row = {
    ticket: 100,
    dealType: 'DEAL_TYPE_BUY',
    entry: 1,
    dealInternalOut: { profit: 10, lots: 0.1 },
  }
  const adjusted = adjustMtTradesPositionDirection(
    row,
    'trades',
    { direction: 'buy', type_label: 'Deal Buy' },
  )
  assert.equal(adjusted.direction, 'sell')
  assert.equal(adjusted.type_label, 'Deal Sell')
})

test('adjustMtTradesPositionDirection: closing buy position uses buy not exit sell deal', () => {
  const row = {
    ticket: 101,
    dealType: 'DEAL_TYPE_SELL',
    entry: 1,
  }
  const adjusted = adjustMtTradesPositionDirection(
    row,
    'trades',
    { direction: 'sell', type_label: 'Deal Sell' },
  )
  assert.equal(adjusted.direction, 'buy')
  assert.equal(adjusted.type_label, 'Deal Buy')
})

test('mergeMtHistoryRow: keeps deal profit and lots when position snapshot is sparse', () => {
  const deal = { ticket: 123, lots: 0.1, profit: 42.5, closeTime: '2026-05-18T10:00:00' }
  const position = { ticket: 123, volume: 0, profit: 0, closeTime: '2026-05-18T10:00:00' }
  const merged = mergeMtHistoryRow(deal, position, 'dashboard')
  assert.equal(resolveMtLots(merged, 'dashboard'), 0.1)
  assert.equal(resolveMtDealProfit(merged, 'dashboard'), 42.5)
})
