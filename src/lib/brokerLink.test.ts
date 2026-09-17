import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countLinkedBrokerSessions,
  hasAnyBrokerSession,
  hasFxsocketBrokerSession,
  hasMtapiBrokerSession,
  isBrokerCopyEnabled,
  isFxsocketLinkedBroker,
  resolveProvider,
} from './brokerLink'

const SESSION_UUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'

describe('brokerLink', () => {
  it('hasFxsocketBrokerSession is true for valid terminal UUID', () => {
    assert.equal(hasFxsocketBrokerSession({ fxsocket_account_id: SESSION_UUID }), true)
  })

  it('hasFxsocketBrokerSession is false for empty or legacy values', () => {
    assert.equal(hasFxsocketBrokerSession({ fxsocket_account_id: null }), false)
    assert.equal(hasFxsocketBrokerSession({ fxsocket_account_id: 'Server|123' }), false)
  })

  it('isFxsocketLinkedBroker matches session linked only', () => {
    const linked = { fxsocket_account_id: SESSION_UUID, is_active: false }
    assert.equal(isFxsocketLinkedBroker(linked), true)
  })

  it('isBrokerCopyEnabled requires copy toggle and session', () => {
    assert.equal(
      isBrokerCopyEnabled({ fxsocket_account_id: SESSION_UUID, is_active: true }),
      true,
    )
    assert.equal(
      isBrokerCopyEnabled({ fxsocket_account_id: SESSION_UUID, is_active: false }),
      false,
    )
    assert.equal(
      isBrokerCopyEnabled({ fxsocket_account_id: null, is_active: true }),
      false,
    )
  })

  it('countLinkedBrokerSessions ignores copy toggle', () => {
    const count = countLinkedBrokerSessions([
      { fxsocket_account_id: SESSION_UUID, is_active: true },
      { fxsocket_account_id: SESSION_UUID, is_active: false },
      { fxsocket_account_id: null, is_active: true },
    ])
    assert.equal(count, 2)
  })
})

describe('brokerLink — MTAPI provider', () => {
  it('resolveProvider returns mtapi when provider=mtapi', () => {
    assert.equal(resolveProvider({ provider: 'mtapi' }), 'mtapi')
  })

  it('resolveProvider defaults to fxsocket for null/undefined', () => {
    assert.equal(resolveProvider({ provider: null }), 'fxsocket')
    assert.equal(resolveProvider({}), 'fxsocket')
  })

  it('resolveProvider defaults to fxsocket for unknown provider string', () => {
    assert.equal(resolveProvider({ provider: 'unknown' }), 'fxsocket')
  })

  it('hasMtapiBrokerSession is true for non-empty session id', () => {
    assert.equal(hasMtapiBrokerSession({ mtapi_session_id: 'sess_abc123' }), true)
  })

  it('hasMtapiBrokerSession is false for null/undefined/empty', () => {
    assert.equal(hasMtapiBrokerSession({ mtapi_session_id: null }), false)
    assert.equal(hasMtapiBrokerSession({ mtapi_session_id: '' }), false)
    assert.equal(hasMtapiBrokerSession({}), false)
  })

  it('hasAnyBrokerSession resolves to MTAPI when provider=mtapi', () => {
    assert.equal(
      hasAnyBrokerSession({ provider: 'mtapi', mtapi_session_id: 'sess_abc123' }),
      true,
    )
  })

  it('hasAnyBrokerSession resolves to FxSocket when provider=fxsocket', () => {
    assert.equal(
      hasAnyBrokerSession({ provider: 'fxsocket', fxsocket_account_id: SESSION_UUID }),
      true,
    )
  })

  it('hasAnyBrokerSession returns false for MTAPI without session', () => {
    assert.equal(
      hasAnyBrokerSession({ provider: 'mtapi', mtapi_session_id: null }),
      false,
    )
  })

  it('isBrokerCopyEnabled works for MTAPI accounts', () => {
    assert.equal(
      isBrokerCopyEnabled({ provider: 'mtapi', mtapi_session_id: 'sess_abc', is_active: true }),
      true,
    )
    assert.equal(
      isBrokerCopyEnabled({ provider: 'mtapi', mtapi_session_id: 'sess_abc', is_active: false }),
      false,
    )
  })

  it('countLinkedBrokerSessions counts MTAPI accounts', () => {
    const count = countLinkedBrokerSessions([
      { provider: 'mtapi', mtapi_session_id: 'sess_abc' },
      { provider: 'fxsocket', fxsocket_account_id: SESSION_UUID },
      { provider: 'mtapi', mtapi_session_id: null },
    ])
    assert.equal(count, 2)
  })
})
