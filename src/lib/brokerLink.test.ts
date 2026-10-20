import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countLinkedBrokerSessions,
  countLinkedBrokerSessionsForUi,
  hasAnyBrokerSession,
  hasFxsocketBrokerSession,
  hasLinkedBrokerForUi,
  hasMtapiBrokerSession,
  isBrokerCopyEnabled,
  isBrokerCopyEnabledForUi,
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
    assert.equal(
      isFxsocketLinkedBroker({ provider: 'mtapi', fxsocket_account_id: SESSION_UUID }),
      false,
    )
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

  it('resolveProvider returns binance and treats the row as linked', () => {
    assert.equal(resolveProvider({ provider: 'binance' }), 'binance')
    assert.equal(hasLinkedBrokerForUi({ provider: 'binance' }), true)
    assert.equal(hasAnyBrokerSession({ provider: 'binance', binance_account_id: 'abcd1234abcd1234' }), true)
    assert.equal(isBrokerCopyEnabledForUi({ provider: 'binance', is_active: true }), true)
    assert.equal(isFxsocketLinkedBroker({ provider: 'binance', fxsocket_account_id: SESSION_UUID }), false)
  })

  it('resolveProvider returns bybit and treats the row as linked', () => {
    assert.equal(resolveProvider({ provider: 'bybit' }), 'bybit')
    assert.equal(hasLinkedBrokerForUi({ provider: 'bybit' }), true)
    assert.equal(hasAnyBrokerSession({ provider: 'bybit', bybit_account_id: 'ef561234ef561234' }), true)
    assert.equal(isBrokerCopyEnabledForUi({ provider: 'bybit', is_active: true }), true)
    assert.equal(isFxsocketLinkedBroker({ provider: 'bybit', fxsocket_account_id: SESSION_UUID }), false)
  })

  it('resolveProvider returns dxtrade and treats the row as linked', () => {
    assert.equal(resolveProvider({ provider: 'dxtrade' }), 'dxtrade')
    assert.equal(hasLinkedBrokerForUi({ provider: 'dxtrade' }), true)
    assert.equal(hasAnyBrokerSession({ provider: 'dxtrade', dxtrade_account_id: '77c01234ef561234' }), true)
    assert.equal(isBrokerCopyEnabledForUi({ provider: 'dxtrade', is_active: true }), true)
    assert.equal(isFxsocketLinkedBroker({ provider: 'dxtrade', fxsocket_account_id: SESSION_UUID }), false)
  })

  it('resolveProvider returns tradelocker and treats the row as linked', () => {
    assert.equal(resolveProvider({ provider: 'tradelocker' }), 'tradelocker')
    assert.equal(hasLinkedBrokerForUi({ provider: 'tradelocker' }), true)
    assert.equal(hasAnyBrokerSession({ provider: 'tradelocker', tradelocker_account_id: '5d0e1234ef561234' }), true)
    assert.equal(isBrokerCopyEnabledForUi({ provider: 'tradelocker', is_active: true }), true)
    assert.equal(isFxsocketLinkedBroker({ provider: 'tradelocker', fxsocket_account_id: SESSION_UUID }), false)
  })

  it('resolveProvider returns matchtrader and treats the row as linked', () => {
    assert.equal(resolveProvider({ provider: 'matchtrader' }), 'matchtrader')
    assert.equal(hasLinkedBrokerForUi({ provider: 'matchtrader' }), true)
    assert.equal(hasAnyBrokerSession({ provider: 'matchtrader', matchtrader_account_id: '5d0e1234ef561234' }), true)
    assert.equal(isBrokerCopyEnabledForUi({ provider: 'matchtrader', is_active: true }), true)
    assert.equal(isFxsocketLinkedBroker({ provider: 'matchtrader', fxsocket_account_id: SESSION_UUID }), false)
  })

  it('resolveProvider returns kucoin and treats the row as linked', () => {
    assert.equal(resolveProvider({ provider: 'kucoin' }), 'kucoin')
    assert.equal(hasLinkedBrokerForUi({ provider: 'kucoin' }), true)
    assert.equal(hasAnyBrokerSession({ provider: 'kucoin', kucoin_account_id: '9a8b1234ef561234' }), true)
    assert.equal(isBrokerCopyEnabledForUi({ provider: 'kucoin', is_active: true }), true)
    assert.equal(isFxsocketLinkedBroker({ provider: 'kucoin', fxsocket_account_id: SESSION_UUID }), false)
  })

  it('resolveProvider returns ctrader and treats the row as linked', () => {
    assert.equal(resolveProvider({ provider: 'ctrader' }), 'ctrader')
    assert.equal(hasLinkedBrokerForUi({ provider: 'ctrader' }), true)
    assert.equal(hasAnyBrokerSession({ provider: 'ctrader', ctrader_account_id: '4242' }), true)
    assert.equal(isBrokerCopyEnabledForUi({ provider: 'ctrader', is_active: true }), true)
    assert.equal(isFxsocketLinkedBroker({ provider: 'ctrader', fxsocket_account_id: SESSION_UUID }), false)
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

describe('brokerLink — hasLinkedBrokerForUi (BROKER_ACCOUNT_CLIENT_SELECT shape)', () => {
  // Mirrors a row the browser actually receives: provider + mtapi_status, no session id.
  it('MTAPI client row without mtapi_session_id still passes the gate', () => {
    assert.equal(
      hasLinkedBrokerForUi({ provider: 'mtapi', mtapi_status: 'connected' }),
      true,
    )
    assert.equal(
      hasLinkedBrokerForUi({ provider: 'mtapi', mtapi_status: null }),
      true,
    )
  })

  it('FxSocket client row still requires a terminal UUID', () => {
    assert.equal(
      hasLinkedBrokerForUi({ provider: 'fxsocket', fxsocket_account_id: SESSION_UUID }),
      true,
    )
    assert.equal(
      hasLinkedBrokerForUi({ provider: 'fxsocket', fxsocket_account_id: null }),
      false,
    )
  })

  it('defaults to FxSocket rules when provider is missing', () => {
    assert.equal(hasLinkedBrokerForUi({}), false)
    assert.equal(hasLinkedBrokerForUi({ fxsocket_account_id: SESSION_UUID }), true)
  })

  it('countLinkedBrokerSessionsForUi counts MTAPI client rows without session id', () => {
    const count = countLinkedBrokerSessionsForUi([
      { provider: 'mtapi', mtapi_status: 'connected' },
      { provider: 'fxsocket', fxsocket_account_id: SESSION_UUID },
      { provider: 'fxsocket', fxsocket_account_id: null },
    ])
    assert.equal(count, 2)
  })

  it('isBrokerCopyEnabledForUi requires copy toggle and client-safe link', () => {
    assert.equal(
      isBrokerCopyEnabledForUi({ provider: 'mtapi', is_active: true }),
      true,
    )
    assert.equal(
      isBrokerCopyEnabledForUi({ provider: 'mtapi', is_active: false }),
      false,
    )
    assert.equal(
      isBrokerCopyEnabledForUi({ provider: 'fxsocket', is_active: true }),
      false,
    )
    assert.equal(
      isBrokerCopyEnabledForUi({
        provider: 'fxsocket',
        fxsocket_account_id: SESSION_UUID,
        is_active: true,
      }),
      true,
    )
  })
})
