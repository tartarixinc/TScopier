import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { brokerHasLinkedSession, brokerSessionUuid } from './helpers'

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
