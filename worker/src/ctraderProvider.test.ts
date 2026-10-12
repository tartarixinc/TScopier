import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CTRADER_PAYLOAD } from './ctrader/protocol'
import type { CtraderSocket } from './ctrader/session'
import { CtraderProvider, type CtraderCredential } from './ctraderProvider'

const credential: CtraderCredential = {
  accountId: '4242',
  environment: 'demo',
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: '2099-01-01T00:00:00.000Z',
  clientId: 'client',
  clientSecret: 'secret',
}

const symbolList = {
  symbol: [{ symbolId: 1, symbolName: 'EURUSD', digits: 5, lotSize: 10_000_000 }],
}

const symbolDetail = {
  symbol: [{ symbolId: 1, symbolName: 'EURUSD', digits: 5, lotSize: 10_000_000 }],
}

function scriptedSocket(steps: Array<{ request: number; responseType: number; payload?: Record<string, unknown> }>) {
  const sent: Array<{ payloadType: number; payload: Record<string, unknown> }> = []
  let cursor = 0
  let onMessage: ((data: string) => void) | null = null
  const socket: CtraderSocket = {
    send(data: string) {
      const message = JSON.parse(data) as { clientMsgId: string; payloadType: number; payload: Record<string, unknown> }
      sent.push({ payloadType: message.payloadType, payload: message.payload })
      const step = steps[cursor]
      cursor += 1
      if (!step || step.request !== message.payloadType) {
        throw new Error(`unexpected cTrader request ${message.payloadType}`)
      }
      queueMicrotask(() => onMessage?.(JSON.stringify({
        clientMsgId: message.clientMsgId,
        payloadType: step.responseType,
        payload: step.payload ?? {},
      })))
    },
    close() {},
    onMessage(handler) { onMessage = handler },
    onClose() {},
  }
  return { socket, sent }
}

function providerFor(steps: Array<{ request: number; responseType: number; payload?: Record<string, unknown> }>) {
  const script = scriptedSocket(steps)
  const provider = new CtraderProvider({
    openSocket: async () => script.socket,
    loadCredentials: async () => credential,
  })
  return { provider, sent: script.sent }
}

const authSteps = [
  { request: CTRADER_PAYLOAD.APPLICATION_AUTH_REQ, responseType: CTRADER_PAYLOAD.APPLICATION_AUTH_RES },
  { request: CTRADER_PAYLOAD.ACCOUNT_AUTH_REQ, responseType: CTRADER_PAYLOAD.ACCOUNT_AUTH_RES },
]

test('cTrader provider authenticates the app and then the account', async () => {
  const { provider, sent } = providerFor([
    ...authSteps,
    {
      request: CTRADER_PAYLOAD.TRADER_REQ,
      responseType: CTRADER_PAYLOAD.TRADER_RES,
      payload: { trader: { balance: 1_000_000, accessRights: 0, leverageInCents: 50000 } },
    },
    {
      request: CTRADER_PAYLOAD.TRADER_REQ,
      responseType: CTRADER_PAYLOAD.TRADER_RES,
      payload: { trader: { balance: 1_000_000, accessRights: 0, leverageInCents: 50000 } },
    },
  ])
  const summary = await provider.accountSummary('4242')
  assert.equal(summary.balance, 10_000)
  assert.equal(summary.leverage, 500)
  assert.equal(sent[0]?.payloadType, CTRADER_PAYLOAD.APPLICATION_AUTH_REQ)
  assert.equal(sent[0]?.payload.clientId, 'client')
  assert.equal(sent[1]?.payloadType, CTRADER_PAYLOAD.ACCOUNT_AUTH_REQ)
  assert.equal(sent[1]?.payload.accessToken, 'access')
  assert.equal(sent[1]?.payload.ctidTraderAccountId, 4242)
  const status = await provider.mtStatus('4242')
  assert.equal(status.account?.tradeAllowed, true)
  assert.equal(status.terminal?.alive, true)
})

test('cTrader market open keeps the copy comment and converts lots', async () => {
  const { provider, sent } = providerFor([
    ...authSteps,
    {
      request: CTRADER_PAYLOAD.SYMBOLS_LIST_REQ,
      responseType: CTRADER_PAYLOAD.SYMBOLS_LIST_RES,
      payload: { symbol: [{ symbolId: 1, symbolName: 'EURUSD' }] },
    },
    { request: CTRADER_PAYLOAD.SYMBOL_BY_ID_REQ, responseType: CTRADER_PAYLOAD.SYMBOL_BY_ID_RES, payload: symbolDetail },
    {
      request: CTRADER_PAYLOAD.NEW_ORDER_REQ,
      responseType: CTRADER_PAYLOAD.EXECUTION_EVENT,
      payload: {
        executionType: 3,
        position: {
          positionId: 9001,
          price: 123456,
          stopLoss: 123000,
          takeProfit: 124000,
          tradeData: { symbolId: 1, volume: 1_000_000, tradeSide: 1, comment: 'TScopier:abc' },
        },
      },
    },
  ])
  const result = await provider.orderSend('4242', {
    symbol: 'EURUSD',
    operation: 'Buy',
    volume: 0.1,
    stoploss: 1.23,
    takeprofit: 1.24,
    comment: 'TScopier:abc',
  })
  const order = sent.find(message => message.payloadType === CTRADER_PAYLOAD.NEW_ORDER_REQ)
  assert.equal(order?.payload.volume, 1_000_000)
  assert.equal(order?.payload.orderType, 1)
  assert.equal(order?.payload.tradeSide, 1)
  assert.equal(order?.payload.comment, 'TScopier:abc')
  assert.equal(order?.payload.stopLoss, 123000)
  assert.equal(order?.payload.takeProfit, 124000)
  assert.equal(result.ticket, 9001)
  assert.equal(result.lots, 0.1)
  assert.equal(result.comment, 'TScopier:abc')
  assert.equal(result.openPrice, 1.23456)
})

test('cTrader reads lot size from the full symbol when the name list omits it', async () => {
  const { provider, sent } = providerFor([
    ...authSteps,
    {
      request: CTRADER_PAYLOAD.SYMBOLS_LIST_REQ,
      responseType: CTRADER_PAYLOAD.SYMBOLS_LIST_RES,
      payload: { symbol: [{ symbolId: 41, symbolName: 'XAUUSD' }] },
    },
    {
      request: CTRADER_PAYLOAD.SYMBOL_BY_ID_REQ,
      responseType: CTRADER_PAYLOAD.SYMBOL_BY_ID_RES,
      payload: { symbol: { symbolId: 41, digits: 2, lotSize: 10_000 } },
    },
    {
      request: CTRADER_PAYLOAD.NEW_ORDER_REQ,
      responseType: CTRADER_PAYLOAD.EXECUTION_EVENT,
      payload: {
        executionType: 3,
        position: {
          positionId: 9002,
          price: 265012,
          tradeData: { symbolId: 41, volume: 1_000, tradeSide: 1, comment: 'TScopier:gold' },
        },
      },
    },
  ])
  const result = await provider.orderSend('4242', {
    symbol: 'XAUUSD',
    operation: 'Buy',
    volume: 0.1,
    comment: 'TScopier:gold',
  })
  const order = sent.find(message => message.payloadType === CTRADER_PAYLOAD.NEW_ORDER_REQ)
  assert.deepEqual(order?.payload.symbolId, 41)
  assert.equal(order?.payload.volume, 1_000)
  assert.equal(result.ticket, 9002)
  assert.equal(result.openPrice, 2650.12)
})

test('cTrader amends position protection in relative prices', async () => {
  const { provider, sent } = providerFor([
    ...authSteps,
    { request: CTRADER_PAYLOAD.SYMBOLS_LIST_REQ, responseType: CTRADER_PAYLOAD.SYMBOLS_LIST_RES, payload: symbolList },
    {
      request: CTRADER_PAYLOAD.RECONCILE_REQ,
      responseType: CTRADER_PAYLOAD.RECONCILE_RES,
      payload: {
        position: [{
          positionId: 9001,
          tradeData: { symbolId: 1, volume: 1_000_000, tradeSide: 1, comment: 'TScopier:abc' },
        }],
      },
    },
    {
      request: CTRADER_PAYLOAD.AMEND_POSITION_SLTP_REQ,
      responseType: CTRADER_PAYLOAD.EXECUTION_EVENT,
      payload: { executionType: 4, position: { positionId: 9001, stopLoss: 122000, takeProfit: 125000 } },
    },
  ])
  const result = await provider.orderModify('4242', {
    ticket: 9001,
    stoploss: 1.22,
    takeprofit: 1.25,
  })
  const amend = sent.find(message => message.payloadType === CTRADER_PAYLOAD.AMEND_POSITION_SLTP_REQ)
  assert.equal(amend?.payload.positionId, 9001)
  assert.equal(amend?.payload.stopLoss, 122000)
  assert.equal(amend?.payload.takeProfit, 125000)
  assert.equal(result.ticket, 9001)
  assert.equal(result.stopLoss, 1.22)
})

test('cTrader partial close sends the converted volume', async () => {
  const { provider, sent } = providerFor([
    ...authSteps,
    { request: CTRADER_PAYLOAD.SYMBOLS_LIST_REQ, responseType: CTRADER_PAYLOAD.SYMBOLS_LIST_RES, payload: symbolList },
    {
      request: CTRADER_PAYLOAD.RECONCILE_REQ,
      responseType: CTRADER_PAYLOAD.RECONCILE_RES,
      payload: {
        position: [{
          positionId: 9001,
          price: 123456,
          tradeData: { symbolId: 1, volume: 10_000_000, tradeSide: 1, comment: 'TSCopier:leg' },
        }],
      },
    },
    {
      request: CTRADER_PAYLOAD.CLOSE_POSITION_REQ,
      responseType: CTRADER_PAYLOAD.EXECUTION_EVENT,
      payload: { executionType: 3, position: { positionId: 9001 } },
    },
  ])
  const result = await provider.orderClose('4242', { ticket: 9001, lots: 0.4 })
  const close = sent.find(message => message.payloadType === CTRADER_PAYLOAD.CLOSE_POSITION_REQ)
  assert.equal(close?.payload.volume, 4_000_000)
  assert.equal(close?.payload.positionId, 9001)
  assert.equal(result.ticket, 9001)
})

test('cTrader opened orders expose ticket, side, lots, and the copy comment', async () => {
  const { provider } = providerFor([
    ...authSteps,
    { request: CTRADER_PAYLOAD.SYMBOLS_LIST_REQ, responseType: CTRADER_PAYLOAD.SYMBOLS_LIST_RES, payload: symbolList },
    {
      request: CTRADER_PAYLOAD.RECONCILE_REQ,
      responseType: CTRADER_PAYLOAD.RECONCILE_RES,
      payload: {
        position: [{
          positionId: 9001,
          price: 123456,
          stopLoss: 123000,
          takeProfit: 124000,
          tradeData: { symbolId: 1, volume: 1_000_000, tradeSide: 1, comment: 'TScopier:abc' },
        }],
        order: [{
          orderId: 77,
          orderType: 2,
          limitPrice: 120000,
          tradeData: { symbolId: 1, volume: 1_000_000, tradeSide: 2, comment: 'TScopier:pend' },
        }],
      },
    },
  ])
  const orders = await provider.openedOrders('4242') as Array<Record<string, unknown>>
  assert.equal(orders[0]?.ticket, 9001)
  assert.equal(orders[0]?.symbol, 'EURUSD')
  assert.equal(orders[0]?.operation, 'Buy')
  assert.equal(orders[0]?.lots, 0.1)
  assert.equal(orders[0]?.comment, 'TScopier:abc')
  assert.equal(orders[1]?.ticket, 77)
  assert.equal(orders[1]?.operation, 'SellLimit')
  assert.equal(orders[1]?.comment, 'TScopier:pend')
})
