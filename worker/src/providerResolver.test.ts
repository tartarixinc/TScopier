import { strict as assert } from 'node:assert'
import { afterEach, test } from 'node:test'
import type { FxsocketBrokerClient, OrderModifyArgs, OrderSendArgs, SymbolParams } from './fxsocketClient'
import { FxsocketProvider } from './fxsocketProvider'
import { MtapiProvider } from './mtapiProvider'
import { apiForFxsocketAccount, brokerSessionId, type PlatformByFxsocketId } from './mtApiByAccount'
import {
  apiForBrokerAccount,
  inferProvider,
  resetProviderResolverForTests,
  setFxsocketProviderForTests,
  setMtapiProviderForResolverTests,
} from './providerResolver'

function fakeClient(overrides: Record<string, unknown> = {}): FxsocketBrokerClient {
  const result = { ticket: 42, comment: 'unchanged' }
  const base = {
    seedPlatformCache() {},
    async connectEx() { return 'session' },
    async connectByToken() {},
    async ensureConnected() {},
    async checkConnect() {},
    async disconnect() {},
    async keepSessionAlive() { return true },
    async verifyTradingReady() { return true },
    async orderSend() { return result },
    async orderModify() { return result },
    async orderClose() { return result },
    async openedOrders() { return [] },
    async closedOrders() { return [] },
    async orderHistory() { return [] },
    async historyPositions() { return [] },
    async orderHistoryPage() { return { orders: [], pagesCount: 1 } },
    async closedOrdersHistory() { return [] },
    async closedOrdersHistoryLite() { return [] },
    async accountSummary() { return {} },
    async quote() { return { symbol: 'XAUUSD', bid: 1, ask: 2 } },
    async symbolParams() { return {} },
    async symbols() { return [] },
    async mtStatus() { return {} },
    async terminalStatus() { return {} },
    ...overrides,
  }
  return base as unknown as FxsocketBrokerClient
}

afterEach(() => resetProviderResolverForTests())

test('resolver uses FXSocket for null, undefined, empty, and explicit fxsocket providers', () => {
  const provider = new FxsocketProvider(fakeClient())
  setFxsocketProviderForTests(provider)
  for (const value of [null, undefined, '', 'fxsocket']) {
    assert.equal(apiForBrokerAccount(value, 'session-123'), provider)
  }
})

test('resolver routes mtapi and fails closed for unknown providers', () => {
  setFxsocketProviderForTests(new FxsocketProvider(fakeClient()))
  const mtapi = new MtapiProvider({ fetchImpl: async () => new Response('OK') })
  setMtapiProviderForResolverTests(mtapi)
  assert.equal(apiForBrokerAccount('mtapi', 'session-123'), mtapi)
  assert.equal(apiForBrokerAccount('unknown-provider', 'session-123'), null)
})

test('shared production account lookup routes through the fail-closed resolver', () => {
  const provider = new FxsocketProvider(fakeClient())
  const mtapi = new MtapiProvider({ fetchImpl: async () => new Response('OK') })
  setFxsocketProviderForTests(provider)
  setMtapiProviderForResolverTests(mtapi)
  const fxMap: PlatformByFxsocketId = new Map([
    ['fx', { platform: 'MT5', provider: 'fxsocket' }],
    ['legacy', { platform: 'MT4', provider: null }],
    ['future', { platform: 'MT5', provider: 'mtapi' }],
    ['invalid', { platform: 'MT5', provider: 'invalid' }],
  ])
  assert.equal(apiForFxsocketAccount(fxMap, 'fx'), provider)
  assert.equal(apiForFxsocketAccount(fxMap, 'legacy'), provider)
  assert.equal(apiForFxsocketAccount(fxMap, 'future'), mtapi)
  assert.equal(apiForFxsocketAccount(fxMap, 'invalid'), null)
})

test('resolver fails closed for invalid sessions and unavailable FXSocket', () => {
  setFxsocketProviderForTests(new FxsocketProvider(fakeClient()))
  assert.equal(apiForBrokerAccount('fxsocket', ''), null)
  assert.equal(apiForBrokerAccount('fxsocket', 'abc|def'), null)
  setFxsocketProviderForTests(null)
  assert.equal(apiForBrokerAccount('fxsocket', 'session-123'), null)
})

test('inferProvider is typed and fails closed for invalid values', () => {
  assert.equal(inferProvider({}), 'fxsocket')
  assert.equal(inferProvider({ provider: null }), 'fxsocket')
  assert.equal(inferProvider({ provider: '' }), 'fxsocket')
  assert.equal(inferProvider({ provider: 'fxsocket' }), 'fxsocket')
  assert.equal(inferProvider({ provider: 'mtapi' }), 'mtapi')
  assert.equal(inferProvider({ provider: 'other' }), null)
})

test('broker session identity is provider-specific and unknown providers fail closed', () => {
  const row = {
    mtapi_session_id: 'mtapi-token',
    fxsocket_account_id: 'fxsocket-id',
    metaapi_account_id: 'legacy-id',
  }
  assert.equal(brokerSessionId({ ...row, provider: 'mtapi' }), 'mtapi-token')
  assert.equal(brokerSessionId({ ...row, provider: 'fxsocket' }), 'fxsocket-id')
  assert.equal(brokerSessionId({ ...row, provider: null }), 'fxsocket-id')
  assert.equal(brokerSessionId({ ...row, provider: 'unknown' }), '')
})

test('FxsocketProvider preserves order arguments and raw return objects', async () => {
  let sendArgs: OrderSendArgs | undefined
  let modifyArgs: OrderModifyArgs | undefined
  const sendResult = { ticket: 7, openPrice: 2010 }
  const modifyResult = { ticket: 7, state: 'modified' }
  const provider = new FxsocketProvider(fakeClient({
    async orderSend(_id: string, args: OrderSendArgs) { sendArgs = args; return sendResult },
    async orderModify(_id: string, args: OrderModifyArgs) { modifyArgs = args; return modifyResult },
  }))
  const send: OrderSendArgs = {
    symbol: 'XAUUSD', operation: 'BuyLimit', volume: 0.1, price: 2000,
    stoploss: 1990, takeprofit: 2020, expertID: 88,
    expiration: '2026-09-17T12:00:00', expirationType: 'Specified',
  }
  const modify: OrderModifyArgs = {
    ticket: 7, price: 2001, stoploss: 1991, takeprofit: 2021,
    expiration: '2026-09-18T12:00:00', expirationType: 'SpecifiedDay',
  }
  assert.equal(await provider.orderSend('session', send), sendResult)
  assert.equal(await provider.orderModify('session', modify), modifyResult)
  assert.equal(sendArgs, send)
  assert.equal(modifyArgs, modify)
})

test('FxsocketProvider preserves disconnect and SymbolParams behavior', async () => {
  let disconnected: string | undefined
  const symbolParams: SymbolParams = {
    symbolName: 'XAUUSD.raw',
    symbol: { digits: 2, point: 0.01, contractSize: 100, stopsLevel: 20 },
    groupParams: { minLot: 0.01, maxLot: 50, lotStep: 0.01 },
    brokerSpecific: { untouched: true },
  }
  const provider = new FxsocketProvider(fakeClient({
    async disconnect(id: string) { disconnected = id },
    async symbolParams() { return symbolParams },
  }))
  await provider.disconnect('session-7')
  assert.equal(disconnected, 'session-7')
  assert.equal(await provider.symbolParams('session-7', 'XAUUSD.raw'), symbolParams)
})
