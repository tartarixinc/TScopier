import { strict as assert } from 'node:assert'
import { afterEach, test } from 'node:test'
import type { FxsocketBrokerClient, OrderSendArgs } from './fxsocketClient'
import { FxsocketProvider } from './fxsocketProvider'
import {
  registerBrokerWriteAuthorityStore,
  resetBrokerWriteAuthorityStoreForTests,
  type BrokerWriteAuthority,
  type BrokerWriteAuthorityStore,
  withBrokerWriteAuthority,
} from './brokerWriteAuthority'
import {
  apiForBrokerAccount,
  resetProviderResolverForTests,
  setFxsocketProviderForTests,
} from './providerResolver'

function fakeClient(onSend: () => void): FxsocketBrokerClient {
  return {
    seedPlatformCache() {}, getV1Account() { return {} as never },
    async connectEx() { return 'session' }, async connectByToken() {}, async ensureConnected() {},
    async checkConnect() {}, async disconnect() {}, async keepSessionAlive() { return true },
    async keepSessionAliveDetailed() { return { alive: true } as never }, async verifyTradingReady() { return true },
    async orderSend() { onSend(); return { ticket: 1 } },
    async orderModify() { return { ticket: 1 } }, async orderClose() { return { ticket: 1 } },
    async openedOrders() { return [] }, async closedOrders() { return [] }, async orderHistory() { return [] },
    async historyPositions() { return [] }, async orderHistoryPage() { return { orders: [], pagesCount: 1 } },
    async closedOrdersHistory() { return [] }, async closedOrdersHistoryLite() { return [] },
    async accountSummary() { return {} }, async quote() { return { symbol: 'X', bid: 1, ask: 2 } },
    async symbolParams() { return {} }, async symbols() { return [] }, async mtStatus() { return {} },
    async terminalStatus() { return {} },
  } as unknown as FxsocketBrokerClient
}

const SEND: OrderSendArgs = { symbol: 'XAUUSD', operation: 'Buy', volume: 0.01 }

afterEach(() => {
  resetBrokerWriteAuthorityStoreForTests()
  resetProviderResolverForTests()
})

test('write guard allows only the current stable provider, session, and epoch', async () => {
  let current = { provider: 'fxsocket', sessionId: 'fx-1', epoch: 1, stable: true }
  let sends = 0
  const store: BrokerWriteAuthorityStore = {
    async acquire(a) {
      if (!current.stable || a.provider !== current.provider || a.sessionId !== current.sessionId || a.writerEpoch !== current.epoch) {
        throw new Error('stale')
      }
      return { id: 'lease-1', writerEpoch: current.epoch }
    },
    async renew() { return true },
    async release() {},
  }
  registerBrokerWriteAuthorityStore(store)
  setFxsocketProviderForTests(new FxsocketProvider(fakeClient(() => { sends += 1 })))
  const authority: BrokerWriteAuthority = {
    brokerAccountId: 'broker-1', provider: 'fxsocket', sessionId: 'fx-1', writerEpoch: 1, transitionState: 'stable',
  }
  const api = apiForBrokerAccount('fxsocket', 'fx-1', authority)!
  await api.orderSend('fx-1', SEND)
  assert.equal(sends, 1)

  current = { ...current, stable: false }
  await assert.rejects(api.orderSend('fx-1', SEND), /BROKER_WRITE_FENCE_REJECTED/)
  current = { provider: 'mtapi', sessionId: 'mt-1', epoch: 2, stable: true }
  await assert.rejects(api.orderSend('fx-1', SEND), /BROKER_WRITE_FENCE_REJECTED/)
  assert.equal(sends, 1)
})

test('stable MTAPI authority can write and transition state blocks it', async () => {
  let current = { provider: 'mtapi', sessionId: 'mt-1', epoch: 2, stable: true }
  let mutations = 0
  registerBrokerWriteAuthorityStore({
    async acquire(a) {
      if (!current.stable || a.provider !== current.provider || a.sessionId !== current.sessionId || a.writerEpoch !== current.epoch) {
        throw new Error('stale')
      }
      return { id: 'mt-lease', writerEpoch: current.epoch }
    },
    async renew() { return true }, async release() {},
  })
  const authority: BrokerWriteAuthority = {
    brokerAccountId: 'broker-1', provider: 'mtapi', sessionId: 'mt-1', writerEpoch: 2, transitionState: 'stable',
  }
  await withBrokerWriteAuthority(authority, 'orderModify', async () => { mutations += 1 })
  assert.equal(mutations, 1)
  current = { ...current, stable: false }
  await assert.rejects(
    withBrokerWriteAuthority(authority, 'orderModify', async () => { mutations += 1 }),
    /BROKER_WRITE_FENCE_REJECTED/,
  )
  assert.equal(mutations, 1)
})

test('rollback epoch rejects stale MTAPI work even after provider returns to FXSocket', async () => {
  const current = { provider: 'fxsocket', sessionId: 'fx-1', epoch: 3, stable: true }
  const store: BrokerWriteAuthorityStore = {
    async acquire(a) {
      if (a.provider !== current.provider || a.sessionId !== current.sessionId || a.writerEpoch !== current.epoch) throw new Error('stale')
      return { id: 'lease', writerEpoch: current.epoch }
    },
    async renew() { return true }, async release() {},
  }
  registerBrokerWriteAuthorityStore(store)
  const staleMtapi: BrokerWriteAuthority = {
    brokerAccountId: 'broker-1', provider: 'mtapi', sessionId: 'mt-1', writerEpoch: 2, transitionState: 'stable',
  }
  await assert.rejects(withBrokerWriteAuthority(staleMtapi, 'orderClose', async () => undefined), /BROKER_WRITE_FENCE_REJECTED/)
})

test('wrong session and missing authority fail before any external mutation', async () => {
  let sends = 0
  registerBrokerWriteAuthorityStore({
    async acquire(a) { return { id: 'lease', writerEpoch: a.writerEpoch } },
    async renew() { return true }, async release() {},
  })
  setFxsocketProviderForTests(new FxsocketProvider(fakeClient(() => { sends += 1 })))
  const authority: BrokerWriteAuthority = {
    brokerAccountId: 'broker-1', provider: 'fxsocket', sessionId: 'fx-1', writerEpoch: 1, transitionState: 'stable',
  }
  await assert.rejects(
    async () => apiForBrokerAccount('fxsocket', 'fx-1', authority)!.orderSend('fx-old', SEND),
    /BROKER_WRITE_FENCE_REJECTED/,
  )
  await assert.rejects(
    apiForBrokerAccount('fxsocket', 'fx-1')!.orderSend('fx-1', SEND),
    /BROKER_WRITE_AUTHORITY_REQUIRED/,
  )
  assert.equal(sends, 0)
})
