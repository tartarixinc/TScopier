import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isCheckConnectOk } from './metatraderapi'

describe('isCheckConnectOk', () => {
  it('accepts common positive shapes', () => {
    assert.equal(isCheckConnectOk(true), true)
    assert.equal(isCheckConnectOk('OK'), true)
    assert.equal(isCheckConnectOk({ connected: true }), true)
    assert.equal(isCheckConnectOk({ result: 'Connected' }), true)
  })

  it('rejects explicit disconnected shapes', () => {
    assert.equal(isCheckConnectOk(false), false)
    assert.equal(isCheckConnectOk('Not connected'), false)
    assert.equal(isCheckConnectOk({ connected: false }), false)
  })
})
