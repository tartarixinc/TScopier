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
