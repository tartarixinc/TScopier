import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { brokerSessionId } from './mtApiByAccount'

const switchedMtapiRow = {
  id: 'b1',
  provider: 'mtapi',
  mtapi_session_id: 'mtapi-session-1',
  mtapi_status: 'connected',
  fxsocket_account_id: '11111111-2222-3333-4444-555555555555',
  metaapi_account_id: null,
  // Leftovers from before the switch. Judging an already-switched account by
  // these columns silently removed it from reconciliation, which is how a
  // position closed at the broker stayed open in our database forever.
  fxsocket_status: 'disconnected',
  connection_status: 'error',
  terminal_connected: false,
  trade_allowed: false,
}

const legacyFxsocketRow = {
  ...switchedMtapiRow,
  provider: 'fxsocket',
  mtapi_session_id: null,
  mtapi_status: null,
}

const unknownProviderRow = {
  ...switchedMtapiRow,
  provider: 'metaapi',
  mtapi_session_id: null,
  mtapi_status: null,
}

test('a switched MTAPI account resolves to its MTAPI session, not its stale FxSocket columns', () => {
  assert.equal(brokerSessionId(switchedMtapiRow), 'mtapi-session-1')
})

test('a legacy FxSocket account resolves to its FxSocket session id', () => {
  assert.equal(brokerSessionId(legacyFxsocketRow), '11111111-2222-3333-4444-555555555555')
})

test('an unknown provider resolves to no session (fail closed)', () => {
  assert.equal(brokerSessionId(unknownProviderRow), '')
})

test('the monitor resolves each account at execution time, with no global FxSocket gate', () => {
  const text = readFileSync('src/openTradeReconcileMonitor.ts', 'utf8')
  assert.equal(text.includes('hasFxsocketConfigured('), false)
  assert.match(text, /loadBrokerApiByAccountId/)
  assert.match(text, /brokerRuntimeForAccount/)
})
