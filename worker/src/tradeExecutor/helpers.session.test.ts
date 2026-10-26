import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { brokerHasLinkedSession, brokerOrderOpenMs, brokerSessionUuid } from './helpers'

const FX_UUID = 'b970faaf-1c0a-4d0a-a999-9bad9c1f0a65'

test('brokerSessionUuid prefers fxsocket_account_id over empty metaapi_account_id', () => {
  const id = brokerSessionUuid({
    fxsocket_account_id: FX_UUID,
    metaapi_account_id: '',
  })
  assert.equal(id, FX_UUID)
  assert.equal(
    brokerHasLinkedSession({ fxsocket_account_id: FX_UUID, metaapi_account_id: '' }),
    true,
  )
})

test('brokerSessionUuid falls back to legacy metaapi_account_id', () => {
  assert.equal(
    brokerSessionUuid({ fxsocket_account_id: '', metaapi_account_id: FX_UUID }),
    FX_UUID,
  )
})

test('brokerHasLinkedSession is false when both session ids are missing', () => {
  assert.equal(
    brokerHasLinkedSession({ fxsocket_account_id: '', metaapi_account_id: '' }),
    false,
  )
})

test('brokerOrderOpenMs: junk numbers are not treated as 1970 seconds', () => {
  assert.equal(brokerOrderOpenMs({ time: 5 }), null)
  assert.equal(brokerOrderOpenMs({ time: 0 }), null)
  assert.equal(brokerOrderOpenMs({ time: -3 }), null)
})

test('brokerOrderOpenMs: epoch seconds, milliseconds and dotted MT4 strings', () => {
  assert.equal(brokerOrderOpenMs({ time: 1792700000 }), 1792700000 * 1000)
  assert.equal(brokerOrderOpenMs({ createTime: 1792700000000 }), 1792700000000)
  const dotted = brokerOrderOpenMs({ timeOpen: '2026.10.25 10:33:00' })
  assert.equal(dotted, Date.parse('2026-10-25 10:33:00'))
  assert.equal(brokerOrderOpenMs({ openTime: '2026-10-25T10:33:00Z' }), Date.parse('2026-10-25T10:33:00Z'))
})
