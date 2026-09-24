import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isPartialTpBenignBrokerError, isPartialTpTriggered, shouldMonitorPartialTpLeg } from './partialTpMonitor'

// Single-mode trades ride to the LAST configured-bucket TP at the broker.
// The earlier TPs are partial-closes fired by the worker: a long basket's
// early TP fires when the BID rises to the trigger (we'd sell at bid); a
// short basket's early TP fires when the ASK falls to the trigger (we'd
// buy back at ask).

test('isPartialTpTriggered: buy fires when bid >= trigger', () => {
  // anchor=1850, TP1=1855 ⇒ bid touches 1855.
  assert.equal(isPartialTpTriggered(true, 1855, 1855, 1855.05), true)
  assert.equal(isPartialTpTriggered(true, 1855, 1856, 1856.05), true)
})

test('isPartialTpTriggered: buy does NOT fire while bid < trigger', () => {
  assert.equal(isPartialTpTriggered(true, 1855, 1854.95, 1855.05), false)
  assert.equal(isPartialTpTriggered(true, 1855, 1840, 1840.1), false)
})

test('isPartialTpTriggered: sell fires when ask <= trigger', () => {
  assert.equal(isPartialTpTriggered(false, 1845, 1844.9, 1845), true)
  assert.equal(isPartialTpTriggered(false, 1845, 1840, 1840.1), true)
})

test('isPartialTpTriggered: sell does NOT fire while ask > trigger', () => {
  assert.equal(isPartialTpTriggered(false, 1845, 1844.9, 1845.05), false)
  assert.equal(isPartialTpTriggered(false, 1845, 1855, 1855.1), false)
})

test('isPartialTpTriggered: rejects invalid inputs', () => {
  assert.equal(isPartialTpTriggered(true, 0, 1855, 1855.05), false)
  assert.equal(isPartialTpTriggered(true, NaN, 1855, 1855.05), false)
  assert.equal(isPartialTpTriggered(true, 1855, NaN, 1855.05), false)
  assert.equal(isPartialTpTriggered(false, 1845, 1840, NaN), false)
})

test('isPartialTpBenignBrokerError: unknown ticket is benign (prod incident 2026-08-10)', () => {
  assert.equal(isPartialTpBenignBrokerError('unknown ticket'), true)
  assert.equal(isPartialTpBenignBrokerError('OrderClose: unknown ticket'), true)
  assert.equal(isPartialTpBenignBrokerError('UNKNOWN TICKET'), true)
})

test('isPartialTpBenignBrokerError: existing benign replies still match', () => {
  assert.equal(isPartialTpBenignBrokerError('trade not found'), true)
  assert.equal(isPartialTpBenignBrokerError('position already closed'), true)
  assert.equal(isPartialTpBenignBrokerError('invalid ticket'), true)
  assert.equal(isPartialTpBenignBrokerError('no such order'), true)
})

test('isPartialTpBenignBrokerError: MT4 error 4108 invalid request is benign (duplicate-close race)', () => {
  assert.equal(isPartialTpBenignBrokerError('MT4 error 4108: Invalid request'), true)
  assert.equal(isPartialTpBenignBrokerError('4108 Invalid request'), true)
})

test('isPartialTpBenignBrokerError: real broker failures stay retryable', () => {
  assert.equal(isPartialTpBenignBrokerError('Insufficient funds'), false)
  assert.equal(isPartialTpBenignBrokerError('trade context busy'), false)
  assert.equal(isPartialTpBenignBrokerError('Invalid stops'), false)
  assert.equal(isPartialTpBenignBrokerError('HTTP 500'), false)
})

test('pending parent trade => zero quote calls and no leg mutation', () => {
  let quoteCalls = 0
  let legMutations = 0
  const monitorable = shouldMonitorPartialTpLeg(
    { broker_account_id: 'healthy-broker', trade_id: 'pending-trade' },
    new Set(),
    new Set(),
  )
  if (monitorable) {
    quoteCalls += 1
    legMutations += 1
  }
  assert.equal(quoteCalls, 0)
  assert.equal(legMutations, 0)
})
