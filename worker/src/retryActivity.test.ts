import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { RETRY_ELIGIBLE_LOG_ACTIONS } from './retryActivity'

test('RETRY_ELIGIBLE_LOG_ACTIONS includes mgmt breakeven and modify', () => {
  assert.equal(RETRY_ELIGIBLE_LOG_ACTIONS.has('mgmt_breakeven'), true)
  assert.equal(RETRY_ELIGIBLE_LOG_ACTIONS.has('mgmt_modify'), true)
  assert.equal(RETRY_ELIGIBLE_LOG_ACTIONS.has('order_send'), true)
  assert.equal(RETRY_ELIGIBLE_LOG_ACTIONS.has('pipeline_parse_dispatch'), false)
})
