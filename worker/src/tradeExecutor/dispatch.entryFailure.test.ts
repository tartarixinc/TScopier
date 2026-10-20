import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { aggregateEntryFailureReason } from './dispatch'
import { SKIP_REASON_ENTRY_NOT_OPENED } from '../manualPlanner'

test('aggregateEntryFailureReason prefers broker failureReason', () => {
  const reason = aggregateEntryFailureReason([
    { openedOrMerged: false, failureReason: 'broker_session_not_connected' },
    { openedOrMerged: false },
  ])
  assert.equal(reason, 'broker_session_not_connected')
})

test('aggregateEntryFailureReason defaults to entry_not_opened', () => {
  const reason = aggregateEntryFailureReason([{ openedOrMerged: false }])
  assert.equal(reason, SKIP_REASON_ENTRY_NOT_OPENED)
})

test('aggregateEntryFailureReason ignores outcomes deferred to another dispatcher', () => {
  const reason = aggregateEntryFailureReason([
    { openedOrMerged: false, deferredToOtherDispatcher: true },
  ])
  assert.equal(reason, null)
})

test('aggregateEntryFailureReason still reports a real failure next to a deferred outcome', () => {
  const reason = aggregateEntryFailureReason([
    { openedOrMerged: false, deferredToOtherDispatcher: true },
    { openedOrMerged: false, failureReason: 'Trading is disabled for symbol XAUUSD.crp (:1387714)' },
  ])
  assert.equal(reason, 'Trading is disabled for symbol XAUUSD.crp (:1387714)')
})

test('aggregateEntryFailureReason does not let a deferred outcome win over a failure', () => {
  const reason = aggregateEntryFailureReason([
    { openedOrMerged: false, failureReason: 'broker_session_not_connected' },
    { openedOrMerged: false, deferredToOtherDispatcher: true },
  ])
  assert.equal(reason, 'broker_session_not_connected')
})

test('aggregateEntryFailureReason prefers the stable code over the raw broker text', () => {
  const reason = aggregateEntryFailureReason([
    {
      openedOrMerged: false,
      failureReason: 'Trading is disabled for symbol XAUUSD.crp (:1387714)',
      failureReasonCode: 'BROKER_SYMBOL_TRADE_DISABLED',
    },
  ])
  assert.equal(reason, 'BROKER_SYMBOL_TRADE_DISABLED')
})
