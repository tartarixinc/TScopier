import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sortTradesOpenFirst } from './tradeDisplay'
import type { MtTrade } from './fxsocketBroker'

function trade(overrides: Partial<MtTrade>): MtTrade {
  return {
    id: 'id',
    broker_id: 'broker',
    broker_label: 'MT5',
    broker_name: null,
    ticket: 1,
    symbol: 'XAUUSDm',
    direction: 'buy',
    type: 'buy',
    lot_size: 0.01,
    entry_price: 4300,
    sl: null,
    tp: null,
    close_price: null,
    profit: null,
    swap: null,
    commission: null,
    comment: null,
    magic: null,
    opened_at: null,
    closed_at: null,
    state: null,
    status: 'open',
    ...overrides,
  }
}

test('sortTradesOpenFirst: open trades always come before closed trades', () => {
  const closed = trade({ status: 'closed', opened_at: '2026-09-25T11:55:00Z', closed_at: '2026-09-25T11:55:00Z' })
  const open = trade({ status: 'open', opened_at: '2026-09-25T11:49:00Z' })
  const olderClosed = trade({ status: 'closed', opened_at: '2026-09-24T13:50:00Z', closed_at: '2026-09-24T13:50:00Z' })
  const sorted = sortTradesOpenFirst([closed, open, olderClosed])
  assert.deepEqual(sorted.map(t => t.status), ['open', 'closed', 'closed'])
})

test('sortTradesOpenFirst: newest first within each group', () => {
  const closedNew = trade({ id: 'c-new', status: 'closed', closed_at: '2026-09-25T11:55:00Z', opened_at: '2026-09-25T11:00:00Z' })
  const closedOld = trade({ id: 'c-old', status: 'closed', closed_at: '2026-09-24T13:50:00Z', opened_at: '2026-09-24T13:00:00Z' })
  const openNew = trade({ id: 'o-new', status: 'open', opened_at: '2026-09-25T11:49:00Z' })
  const openOld = trade({ id: 'o-old', status: 'open', opened_at: '2026-09-25T10:00:00Z' })
  const sorted = sortTradesOpenFirst([closedOld, openOld, closedNew, openNew])
  assert.deepEqual(sorted.map(t => t.id), ['o-new', 'o-old', 'c-new', 'c-old'])
})

test('sortTradesOpenFirst: closed rows fall back to opened_at and do not mutate input', () => {
  const noClosedTime = trade({ id: 'x', status: 'closed', closed_at: null, opened_at: '2026-09-25T09:00:00Z' })
  const open = trade({ id: 'o', status: 'open', opened_at: '2026-09-25T08:00:00Z' })
  const input = [noClosedTime, open]
  const sorted = sortTradesOpenFirst(input)
  assert.deepEqual(sorted.map(t => t.id), ['o', 'x'])
  assert.deepEqual(input.map(t => t.id), ['x', 'o'])
})
