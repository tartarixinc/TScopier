import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseAttemptCount,
  retryBackoffMs,
  shouldRetryAfterFailure,
} from './signalQueueRetry'
import { resetSignalQueueConfigCache } from './signalQueueConfig'

test('parseAttemptCount defaults to 1', () => {
  assert.equal(parseAttemptCount({}), 1)
  assert.equal(parseAttemptCount({ attempts: '3' }), 3)
})

test('shouldRetryAfterFailure respects max attempts', () => {
  process.env.TRADE_SIGNAL_QUEUE_MAX_ATTEMPTS = '3'
  resetSignalQueueConfigCache()
  assert.equal(shouldRetryAfterFailure(1), true)
  assert.equal(shouldRetryAfterFailure(2), true)
  assert.equal(shouldRetryAfterFailure(3), false)
})

test('retryBackoffMs grows with attempts', () => {
  assert.ok(retryBackoffMs(1) <= retryBackoffMs(3))
})
