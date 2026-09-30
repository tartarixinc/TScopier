import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcilable } from './openTradeReconcileMonitor'

const fxsocketRow = {
  id: 'b1',
  provider: 'fxsocket',
  mtapi_session_id: null,
  mtapi_status: null,
  fxsocket_account_id: '11111111-2222-3333-4444-555555555555',
  metaapi_account_id: null,
  fxsocket_status: 'connected',
  connection_status: 'connected',
  terminal_connected: true,
  trade_allowed: true,
}

test('a healthy FxSocket account is reconciled', () => {
  assert.equal(reconcilable({ ...fxsocketRow }), true)
})

test('a fully dead FxSocket account is skipped', () => {
  assert.equal(reconcilable({
    ...fxsocketRow,
    fxsocket_status: 'disconnected',
    connection_status: 'error',
    terminal_connected: false,
    trade_allowed: false,
  }), false)
})

test('a switched MTAPI account is reconciled even though its FxSocket columns are stale', () => {
  // This is the case that silently broke before: the row still carries the old
  // FxSocket state from before the switch, and judging it by that state removed
  // it from reconciliation entirely.
  assert.equal(reconcilable({
    ...fxsocketRow,
    provider: 'mtapi',
    mtapi_session_id: 'mtapi-session-1',
    mtapi_status: 'connected',
    fxsocket_status: 'disconnected',
    connection_status: 'connected',
    terminal_connected: false,
    trade_allowed: false,
  }), true)
})

test('an MTAPI account whose own status is broken is skipped', () => {
  assert.equal(reconcilable({
    ...fxsocketRow,
    provider: 'mtapi',
    mtapi_session_id: null,
    mtapi_status: 'error',
    connection_status: 'error',
  }), false)
})

test('an MTAPI account with no observed status yet is still reconciled', () => {
  // mtapi_status is null until the first observation; connection_status still
  // shows the pre-switch value. Nothing here says the account is dead.
  assert.equal(reconcilable({
    ...fxsocketRow,
    provider: 'mtapi',
    mtapi_session_id: 'mtapi-session-1',
    mtapi_status: null,
    connection_status: 'connected',
  }), true)
})
