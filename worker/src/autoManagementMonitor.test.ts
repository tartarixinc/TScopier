import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  isUnresolvableFailure,
  isUnconfirmedStopEscalatable,
  sanitizeBrokerPayloadForLog,
} from './autoManagementMonitor'

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

test('audit payload redaction removes echoed bridge credentials', () => {
  assert.deepEqual(
    sanitizeBrokerPayloadForLog({
      message: 'client not found Authorization : Bearer abc123def456ghi789',
      token: 'x-internal-token=abc123def456ghi789',
      nested: { note: 'nothing secret here' },
    }),
    {
      message: 'client not found Authorization : Bearer [REDACTED]',
      token: 'x-internal-token=[REDACTED]',
      nested: { note: 'nothing secret here' },
    },
  )
})

test('audit payload redaction bounds depth, size, and array length', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const value = sanitizeBrokerPayloadForLog(cyclic)
  const serialized = JSON.stringify(value)
  assert.match(serialized, /\[truncated\]/)
  assert.doesNotThrow(() => JSON.parse(serialized))

  assert.equal(
    sanitizeBrokerPayloadForLog('x'.repeat(5_000))?.toString().length,
    4_000,
  )

  const wide = sanitizeBrokerPayloadForLog(Array.from({ length: 60 }, (_, i) => i))
  assert.equal(Array.isArray(wide) && wide.length, 50)

  const deep = sanitizeBrokerPayloadForLog({ a: { b: { c: { d: { e: { f: { g: 'hidden' } } } } } } })
  assert.deepEqual(deep, { a: { b: { c: { d: { e: { f: '[truncated]' } } } } } })

  const manyKeys = Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['k' + i, i]))
  assert.equal((sanitizeBrokerPayloadForLog(manyKeys) as Record<string, unknown>)._truncated, true)
})
