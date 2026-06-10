import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyBrokerConnectError,
  friendlyBrokerConnectError,
  isMtBridgeGlitchMessage,
  isSessionDropMessage,
} from './brokerConnectError'

describe('brokerConnectError', () => {
  it('treats MetatraderAPI null reference as session drop, not wrong login', () => {
    const raw = 'Object reference not set to an instance of an object. (:52886408)'
    assert.equal(isMtBridgeGlitchMessage(raw), true)
    assert.equal(classifyBrokerConnectError(raw), 'session_expired')
    assert.equal(isSessionDropMessage(raw), true)
  })

  it('still classifies invalid login as wrong_login', () => {
    assert.equal(classifyBrokerConnectError('invalid login'), 'wrong_login')
    assert.equal(classifyBrokerConnectError('Invalid account'), 'wrong_login')
  })

  it('classifies not connected with login suffix as session_expired for existing sessions', () => {
    assert.equal(classifyBrokerConnectError('Not connected (:52886408)'), 'session_expired')
  })

  it('classifies not connected as credentials_rejected during fresh credential connect', () => {
    assert.equal(
      classifyBrokerConnectError('Not connected (:52886408)', { credentialConnect: true }),
      'credentials_rejected',
    )
    assert.match(
      friendlyBrokerConnectError('Not connected (:52886408)', { credentialConnect: true }),
      /account number, trading password/i,
    )
  })

  it('classifies INVALID_PASSWORD API codes as wrong_password', () => {
    assert.equal(classifyBrokerConnectError('Connect failed', { errorCode: 'INVALID_PASSWORD' }), 'wrong_password')
  })
})
