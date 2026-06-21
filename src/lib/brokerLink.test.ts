import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countLinkedBrokerSessions,
  hasFxsocketBrokerSession,
  isBrokerCopyEnabled,
  isFxsocketLinkedBroker,
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
