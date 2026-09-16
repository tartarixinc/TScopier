import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { resolveNativePendingCapability } from './layeringBrokerCapability'

const api = {
  orderSend: async () => ({ ticket: 1 }),
  quote: async () => ({ symbol: 'XAUUSD', bid: 1, ask: 2 }),
  openedOrders: async () => [],
  orderClose: async () => ({ ticket: 1 }),
}

test('FxSocket MT4 and MT5 accounts are supported when exact native methods exist', () => {
  for (const platform of ['MT4', 'MT5']) {
    const result = resolveNativePendingCapability({
      broker: { platform, fxsocket_account_id: 'fx-1', connection_status: 'connected', trade_allowed: true },
      api,
    })
    assert.equal(result.supported, true)
    assert.equal(result.provider, 'fxsocket')
    assert.equal(result.canPlace, true)
    assert.equal(result.canReconcile, true)
    assert.equal(result.canCancel, true)
  }
})

test('generic API object without FxSocket account is rejected', () => {
  const result = resolveNativePendingCapability({
    broker: { platform: 'MT5', connection_status: 'connected', trade_allowed: true },
    api,
  })
  assert.equal(result.supported, false)
  assert.equal(result.reason, 'provider_unsupported')
})

test('MTAPI remains unsupported in Phase 1 even when methods are present', () => {
  const result = resolveNativePendingCapability({
    broker: {
      provider: 'mtapi',
      platform: 'MT5',
      metaapi_account_id: 'future-session',
      connection_status: 'connected',
      trade_allowed: true,
    },
    api,
  })
  assert.equal(result.supported, false)
  assert.equal(result.provider, 'mtapi')
  assert.equal(result.reason, 'provider_unsupported')
})

test('unknown explicit provider remains unknown and fails closed', () => {
  const result = resolveNativePendingCapability({
    broker: {
      provider: 'unexpected',
      platform: 'MT5',
      fxsocket_account_id: 'fx-1',
      connection_status: 'connected',
      trade_allowed: true,
    },
    api,
  })
  assert.equal(result.supported, false)
  assert.equal(result.provider, 'unknown')
  assert.equal(result.reason, 'provider_unsupported')
})

test('FxSocket unsupported platform is rejected', () => {
  const result = resolveNativePendingCapability({
    broker: { platform: 'ctrader', fxsocket_account_id: 'fx-1', connection_status: 'connected', trade_allowed: true },
    api,
  })
  assert.equal(result.supported, false)
  assert.equal(result.reason, 'platform_unsupported')
})

test('missing reconciliation or cancellation methods fail closed', () => {
  assert.equal(resolveNativePendingCapability({
    broker: { platform: 'MT5', fxsocket_account_id: 'fx-1', connection_status: 'connected', trade_allowed: true },
    api: { orderSend: api.orderSend, quote: api.quote, orderClose: api.orderClose },
  }).reason, 'reconciliation_unavailable')
  assert.equal(resolveNativePendingCapability({
    broker: { platform: 'MT5', fxsocket_account_id: 'fx-1', connection_status: 'connected', trade_allowed: true },
    api: { orderSend: api.orderSend, quote: api.quote, openedOrders: api.openedOrders },
  }).reason, 'cancellation_unavailable')
})

test('disconnected account is rejected', () => {
  const result = resolveNativePendingCapability({
    broker: { platform: 'MT5', fxsocket_account_id: 'fx-1', connection_status: 'disconnected', trade_allowed: true },
    api,
  })
  assert.equal(result.supported, false)
  assert.equal(result.reason, 'connection_not_ready')
})
