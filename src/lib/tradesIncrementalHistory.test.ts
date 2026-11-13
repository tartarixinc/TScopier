import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MtTrade } from './fxsocketBroker'
import {
  incrementalHistoryFrom,
  mergeIncrementalTrades,
} from './tradesIncrementalHistory'

function trade(
  overrides: Partial<MtTrade> & Pick<MtTrade, 'broker_id' | 'ticket'>,
): MtTrade {
  return {
    id: `${overrides.broker_id}:${overrides.ticket}`,
    broker_label: 'Acct',
    broker_name: 'Broker',
    symbol: 'XAUUSD',
    direction: 'buy',
    type: 'Buy',
    lot_size: 0.1,
    entry_price: 2500,
    sl: null,
    tp: null,
    close_price: 2510,
    profit: 100,
    swap: 0,
    commission: 0,
    comment: null,
    magic: null,
    opened_at: '2026-11-13T10:00:00',
    closed_at: '2026-11-13T12:00:00',
    state: null,
    status: 'closed',
    ...overrides,
  }
}

describe('incrementalHistoryFrom', () => {
  it('starts one day before the newest cached close', () => {
    const trades = [
      trade({ broker_id: 'b1', ticket: 1, closed_at: '2026-11-10T12:00:00' }),
      trade({ broker_id: 'b1', ticket: 2, closed_at: '2026-11-13T12:00:00' }),
    ]
    assert.equal(incrementalHistoryFrom(trades), '2026-11-12')
  })

  it('clamps dormant accounts to the last seven days', () => {
    const now = new Date(2026, 10, 13, 12).getTime()
    const trades = [
      trade({ broker_id: 'b1', ticket: 1, closed_at: '2026-08-01T12:00:00' }),
    ]
    assert.equal(incrementalHistoryFrom(trades, now), '2026-11-06')
  })

  it('never requests a window that starts in the future', () => {
    const now = new Date(2026, 10, 13, 12).getTime()
    const trades = [
      trade({ broker_id: 'b1', ticket: 1, closed_at: '2026-12-01T12:00:00' }),
    ]
    assert.equal(incrementalHistoryFrom(trades, now), '2026-11-13')
  })

  it('starts yesterday when the cache has no closed trades', () => {
    const now = new Date(2026, 10, 13, 12).getTime()
    const trades = [
      trade({
        broker_id: 'b1',
        ticket: 1,
        status: 'open',
        closed_at: null,
        opened_at: '2026-11-01T10:00:00',
      }),
    ]
    assert.equal(incrementalHistoryFrom(trades, now), '2026-11-12')
  })
})

describe('mergeIncrementalTrades', () => {
  it('keeps cached closes missing from live, prefers live rows, and drops cached opens', () => {
    const live = [
      trade({ broker_id: 'b1', ticket: 2, closed_at: '2026-11-13T12:00:00' }),
      trade({
        broker_id: 'b1',
        ticket: 3,
        status: 'open',
        closed_at: null,
        opened_at: '2026-11-10T09:00:00',
      }),
    ]
    const cached = [
      trade({ broker_id: 'b1', ticket: 1, closed_at: '2026-10-01T12:00:00' }),
      trade({ broker_id: 'b1', ticket: 2, closed_at: '2026-11-13T10:00:00' }),
      trade({
        broker_id: 'b1',
        ticket: 3,
        status: 'open',
        closed_at: null,
        opened_at: '2026-11-10T09:00:00',
      }),
      trade({ broker_id: 'b1', ticket: 4, closed_at: '2026-11-13T13:00:00' }),
    ]

    const merged = mergeIncrementalTrades(live, cached)
    assert.deepEqual(merged.map(t => t.id), ['b1:4', 'b1:2', 'b1:3', 'b1:1'])
    assert.equal(merged.find(t => t.id === 'b1:2')?.closed_at, '2026-11-13T12:00:00')
  })

  it('drops cached rows for accounts that are no longer linked', () => {
    const live = [trade({ broker_id: 'b1', ticket: 2 })]
    const cached = [trade({ broker_id: 'b2', ticket: 1, closed_at: '2026-10-01T12:00:00' })]

    const merged = mergeIncrementalTrades(live, cached, new Set(['b1']))
    assert.deepEqual(merged.map(t => t.id), ['b1:2'])
  })

  it('drops live rows for accounts that are no longer linked', () => {
    const live = [
      trade({ broker_id: 'b1', ticket: 1 }),
      trade({ broker_id: 'b2', ticket: 2 }),
    ]
    const merged = mergeIncrementalTrades(live, [], new Set(['b1']))
    assert.deepEqual(merged.map(t => t.id), ['b1:1'])
  })

  it('sorts rows with missing times last', () => {
    const live = [
      trade({
        broker_id: 'b1',
        ticket: 1,
        closed_at: null,
        opened_at: null,
      }),
      trade({ broker_id: 'b1', ticket: 2, closed_at: '2026-10-01T12:00:00' }),
    ]
    const merged = mergeIncrementalTrades(live, [])
    assert.deepEqual(merged.map(t => t.id), ['b1:2', 'b1:1'])
  })

  it('does not duplicate rows with the same id', () => {
    const live = [trade({ broker_id: 'b1', ticket: 1 })]
    const cached = [trade({ broker_id: 'b1', ticket: 1, closed_at: '2026-10-01T12:00:00' })]

    const merged = mergeIncrementalTrades(live, cached)
    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.closed_at, '2026-11-13T12:00:00')
  })
})
