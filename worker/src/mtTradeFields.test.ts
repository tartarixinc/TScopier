import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { ingestMtHistoryRows, resolveMtLots } from './mtTradeFields'

test('ingestMtHistoryRows: merges rows by ticket key', () => {
  const target = new Map<string, Record<string, unknown>>()
  ingestMtHistoryRows(target, [
    { ticket: 123, lots: 0.1, profit: 42.5, closeTime: '2026-05-18T10:00:00' },
    { ticket: 123, volume: 0, profit: 0, closeTime: '2026-05-18T10:00:00' },
  ], 'dashboard')
  assert.equal(target.size, 1)
  const merged = target.get('123')!
  assert.equal(merged.lots, 0.1)
  assert.equal(merged.profit, 42.5)
})

test('ingestMtHistoryRows: reads lots and profit from dealInternalOut on trades profile', () => {
  const target = new Map<string, Record<string, unknown>>()
  ingestMtHistoryRows(target, [{
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
  }], 'trades')
  assert.equal(target.size, 1)
  const row = [...target.values()][0]!
  assert.equal(row.lots, 0.12)
  assert.equal(row.profit, 87.4)
})

test('resolveMtLots: present-but-zero keys do not shadow a positive lot value', () => {
  // Open orders echo closeLots: 0 — the scan must skip zeros (trades profile).
  assert.equal(resolveMtLots({ ticket: 1, lots: 0, closeLots: 0.01 }, 'trades'), 0.01)
  assert.equal(resolveMtLots({ ticket: 2, lots: 0.01, closeLots: 0 }, 'trades'), 0.01)
  assert.equal(resolveMtLots({ ticket: 3, lots: 0, closeLots: 0 }, 'trades'), 0)
  assert.equal(resolveMtLots({ ticket: 4, lots: 0.05 }, 'dashboard'), 0.05)
})
