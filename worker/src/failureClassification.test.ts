import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isLivePositionAbsentReason, isUnresolvableFailure } from './failureClassification'
import { resolveCanonicalOpenPosition } from './livePositionIdentity'

test('absent-position reasons: the row matched nothing in the live snapshot', () => {
  // Ticket missed the snapshot, no attribute candidates at all.
  assert.equal(isLivePositionAbsentReason('stored ticket has no live position match'), true)
  // Ticket missed the snapshot, identical siblings make attributes ambiguous.
  assert.equal(isLivePositionAbsentReason('attributes match multiple live positions'), true)
  // The full messages management throws around the reason.
  assert.equal(
    isLivePositionAbsentReason(
      'automatic management reconciliation required: attributes match multiple live positions',
    ),
    true,
  )
  assert.equal(
    isLivePositionAbsentReason(
      'live position reconciliation required: stored ticket has no live position match',
    ),
    true,
  )
})

test('live-position and data-problem reasons are NOT absent', () => {
  // A live position matched by attributes only — refuse to touch it, stay loud.
  assert.equal(
    isLivePositionAbsentReason('identity match is by attributes only; not persisted'),
    false,
  )
  // Incomplete snapshot: absence is unproven.
  assert.equal(isLivePositionAbsentReason('OpenedOrders response is not a complete list'), false)
  // Corrupt/odd data: needs review, not a silent defer.
  assert.equal(isLivePositionAbsentReason('stored ticket is invalid'), false)
  assert.equal(isLivePositionAbsentReason('stored ticket maps to multiple live positions'), false)
  assert.equal(isLivePositionAbsentReason('no explicit relationship and insufficient attributes'), false)
  assert.equal(isLivePositionAbsentReason(null), false)
  assert.equal(isLivePositionAbsentReason(''), false)
})

test('the absent predicate stays a strict subset of the unresolvable classifier', () => {
  // Anything we silently defer must at least also back off hard if it ever
  // reaches the generic failure path.
  for (const reason of [
    'stored ticket has no live position match',
    'attributes match multiple live positions',
  ]) {
    assert.equal(isUnresolvableFailure(reason), true, reason)
    assert.equal(isLivePositionAbsentReason(reason), true, reason)
  }
})

// Resolver-level guard: the predicate must match the strings
// `resolveCanonicalOpenPosition` actually produces, so a wording change in the
// resolver cannot silently revert both call sites to the old failed-log path.

const baseTrade = {
  id: 'trade-1',
  metaapi_order_id: '101',
  symbol: 'EURUSD',
  direction: 'buy',
  lot_size: 0.2,
  entry_price: 1.1,
}

test('predicate matches the resolver absent reasons end-to-end', () => {
  // Stored ticket missing from the snapshot + identical siblings → ambiguous.
  const multi = resolveCanonicalOpenPosition({
    trade: { ...baseTrade, metaapi_order_id: '999' },
    openedOrders: [
      { type: 0, ticket: 303, symbol: 'EURUSD', lots: 0.2, openPrice: 1.1 },
      { type: 0, ticket: 404, symbol: 'EURUSD', lots: 0.2, openPrice: 1.1 },
    ],
  })
  assert.equal(multi.status, 'ambiguous')
  assert.equal(isLivePositionAbsentReason(multi.reason), true)

  // Stored ticket missing + no attribute candidates → missing.
  const none = resolveCanonicalOpenPosition({
    trade: { ...baseTrade, metaapi_order_id: '999' },
    openedOrders: [{ type: 0, ticket: 505, symbol: 'GBPUSD', lots: 0.2, openPrice: 1.3 }],
  })
  assert.equal(none.status, 'missing')
  assert.equal(isLivePositionAbsentReason(none.reason), true)

  // Live position found by its stored ticket → resolved, never "absent".
  const live = resolveCanonicalOpenPosition({
    trade: { ...baseTrade, broker_position_ticket: '303' },
    openedOrders: [{ type: 0, ticket: 303, symbol: 'EURUSD', lots: 0.2, openPrice: 1.1 }],
  })
  assert.equal(live.status, 'resolved')
  assert.equal(
    isLivePositionAbsentReason(
      'reason' in live && typeof live.reason === 'string' ? live.reason : undefined,
    ),
    false,
  )
})
