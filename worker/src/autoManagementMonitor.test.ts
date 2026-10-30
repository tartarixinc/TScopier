import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isUnresolvableFailure, isUnconfirmedStopEscalatable } from './autoManagementMonitor'

test('identity/ambiguous failures are classified unresolvable', () => {
  assert.equal(
    isUnresolvableFailure('automatic management reconciliation required: stored ticket has no live position match'),
    true,
  )
  assert.equal(isUnresolvableFailure('stored ticket maps to multiple live positions'), true)
  assert.equal(isUnresolvableFailure('attributes match multiple live positions'), true)
})

test('an unconfirmed breakeven modify is transient, not unresolvable', () => {
  // It can be a read race, so it must be retried soon rather than parked.
  assert.equal(
    isUnresolvableFailure(
      'breakeven modify not confirmed by broker: ticket=2013291582 expected_sl=4150.25 broker_sl=none',
    ),
    false,
  )
})

test('transient failures are not classified unresolvable', () => {
  assert.equal(isUnresolvableFailure('MTAPI AccountSummary timed out'), false)
  assert.equal(isUnresolvableFailure('network error'), false)
  assert.equal(isUnresolvableFailure(''), false)
  assert.equal(isUnresolvableFailure(null), false)
})

test('a silent no-op modify is escalatable but a failed read is not', () => {
  // Broker accepted the modify but still shows no stop -> worth parking.
  assert.equal(
    isUnconfirmedStopEscalatable(
      'breakeven modify not confirmed by broker: ticket=2013291582 expected_sl=4150.25 broker_sl=none',
    ),
    true,
  )
  // The same message with a failed read must stay transient forever.
  assert.equal(
    isUnconfirmedStopEscalatable(
      'breakeven modify not confirmed by broker: ticket=2013291582 expected_sl=4150.25 broker_sl=none (opened-orders read failed)',
    ),
    false,
  )
  assert.equal(isUnconfirmedStopEscalatable('MTAPI AccountSummary timed out'), false)
})
