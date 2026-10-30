import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { historyContainsClosedPosition, mappingIsOpen, mirrorCopyComment } from './mirrorCopyReconcile'

test('mirrorCopyComment is deterministic, prefixed, and within the broker comment limit', () => {
  const comment = mirrorCopyComment('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', '42')
  assert.equal(comment, 'mc:bbbbbbbb:42')
  assert.ok(comment.length <= 31)
  assert.equal(mirrorCopyComment('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', '999999999999999999999999999'), mirrorCopyComment('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', '999999999999999999999999999'))
  assert.ok(mirrorCopyComment('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', '999999999999999999999999999').length <= 31)
})

test('mappingIsOpen only treats closed as terminal', () => {
  for (const state of ['opening', 'open', 'closing', 'uncertain', 'error']) assert.equal(mappingIsOpen(state), true, state)
  assert.equal(mappingIsOpen('closed'), false)
})

test('historyContainsClosedPosition reads the position id out of fxsocket deal rows', () => {
  // A final close deal: entry "out", order 0, ticket is the deal, position is the position.
  const closed = [{ ticket: 2694451250, order: 0, entry: 'Out', position: 42, closePrice: 1.1, profit: 5 }]
  assert.equal(historyContainsClosedPosition(closed, '42', 'fxsocket'), true)
  // A partial close (order !== 0) must not count as a full close.
  assert.equal(historyContainsClosedPosition([{ ticket: 1, order: 5, entry: 'Out', position: 42, closePrice: 1.1, profit: 5 }], '42', 'fxsocket'), false)
  // An entry deal (not out) must not count.
  assert.equal(historyContainsClosedPosition([{ ticket: 9, order: 0, entry: 'In', position: 42, closePrice: 1.1, profit: 5 }], '42', 'fxsocket'), false)
  assert.equal(historyContainsClosedPosition([{ position: 43, order: 0, entry: 'Out', closePrice: 1.1, profit: 5 }], '42', 'fxsocket'), false)
})

test('historyContainsClosedPosition is inert on empty input and bad tickets', () => {
  assert.equal(historyContainsClosedPosition([], '42', 'fxsocket'), false)
  assert.equal(historyContainsClosedPosition([null, 'x', 5], '42', 'mtapi'), false)
  assert.equal(historyContainsClosedPosition([{ position: 42, order: 0, entry: 'Out', closePrice: 1.1 }], '0', 'fxsocket'), false)
})

test('historyContainsClosedPosition confirms a value-less close row and rejects open or non-fill rows', () => {
  // What an observed close looks like (a cTrader closing deal, or a position
  // this worker watched disappear from a crypto book): the tracked ticket, a
  // close time and a positive size — but no price and no profit, because a
  // row without a value must never be written as a trade's fill.
  const observed = {
    ticket: 9001, positionTicket: 9001, symbol: 'EURUSD', operation: 'Buy',
    lots: 0.1, closeTime: 1_761_500_600_000, comment: '', observed: 'position_gone',
  }
  assert.equal(historyContainsClosedPosition([observed], '9001', 'binance'), true)
  assert.equal(historyContainsClosedPosition([observed], '9002', 'binance'), false)

  // The same ticket without a close time is an open echo: never a close.
  assert.equal(historyContainsClosedPosition([{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.1 }], '9001', 'binance'), false)
  // A balance-style row (no size, no symbol) is not a position either.
  assert.equal(historyContainsClosedPosition([{ ticket: 9001, symbol: '', lots: 0, closeTime: 1_761_500_600_000 }], '9001', 'binance'), false)
  // A cancelled or pending state is never a fill.
  assert.equal(historyContainsClosedPosition([{ ticket: 9001, symbol: 'EURUSD', lots: 0.1, closeTime: 1_761_500_600_000, state: 'Canceled' }], '9001', 'binance'), false)
})
