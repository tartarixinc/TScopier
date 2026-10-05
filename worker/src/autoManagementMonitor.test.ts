import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isUnresolvableFailure } from './autoManagementMonitor'

test('identity/ambiguous failures are classified unresolvable', () => {
  assert.equal(
    isUnresolvableFailure('automatic management reconciliation required: stored ticket has no live position match'),
    true,
  )
  assert.equal(isUnresolvableFailure('stored ticket maps to multiple live positions'), true)
  assert.equal(isUnresolvableFailure('attributes match multiple live positions'), true)
})

test('transient failures are not classified unresolvable', () => {
  assert.equal(isUnresolvableFailure('MTAPI AccountSummary timed out'), false)
  assert.equal(isUnresolvableFailure('network error'), false)
  assert.equal(isUnresolvableFailure(''), false)
  assert.equal(isUnresolvableFailure(null), false)
})
