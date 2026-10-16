import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { BinanceProvider } from './binanceProvider'
import { BinanceApiError, BinanceFuturesClient, type BinanceFuturesCredential } from './binance/futuresClient'

const API_KEY = 'test-api-key'
const API_SECRET = 'test-api-secret'
const NOW = 1_700_000_000_000

const exchangeInfo = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      pricePrecision: 2,
      quantityPrecision: 3,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
        { filterType: 'MIN_NOTIONAL', notional: '100' },
      ],
    },
    {
      symbol: 'XAUUSDT',
      status: 'TRADING',
      pricePrecision: 2,
      quantityPrecision: 3,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ],
    },
  ],
}

type Call = { method: string; path: string; params: Record<string, string>; signed: boolean; keyHeader?: string; signatureValid: boolean }
type Reply = unknown | { status: number; body: unknown } | ((call: Call) => unknown)

function isStatusReply(value: unknown): value is { status: number; body: unknown } {
  return !!value && typeof value === 'object' && 'status' in value && 'body' in value
}

class FakeBinance {
  calls: Call[] = []
  replies = new Map<string, Reply>()
  nextOrderId = 9001
  nextAlgoId = 5001
  positions: Array<Record<string, unknown>> = []
  openAlgo: Array<Record<string, unknown>> = []
  hedge = false
  ask = 65_000
  bid = 64_990

  constructor() {
    this.replies.set('GET /fapi/v1/time', { serverTime: NOW })
    this.replies.set('GET /fapi/v1/exchangeInfo', exchangeInfo)
    this.replies.set('GET /fapi/v1/ticker/bookTicker', () => ({ symbol: 'BTCUSDT', bidPrice: String(this.bid), askPrice: String(this.ask) }))
    this.replies.set('GET /fapi/v1/positionSide/dual', () => ({ dualSidePosition: this.hedge }))
    this.replies.set('POST /fapi/v1/marginType', { code: 200, msg: 'success' })
    this.replies.set('POST /fapi/v1/leverage', { leverage: 10 })
    this.replies.set('POST /fapi/v1/order', (call: Call) => {
      const orderId = this.nextOrderId++
      const qty = call.params.quantity ?? '0'
      return {
        orderId,
        symbol: call.params.symbol,
        status: call.params.type === 'MARKET' ? 'FILLED' : 'NEW',
        executedQty: call.params.type === 'MARKET' ? qty : '0',
        avgPrice: call.params.type === 'MARKET' ? String(call.params.side === 'BUY' ? this.ask : this.bid) : '0',
      }
    })
    this.replies.set('POST /fapi/v1/algoOrder', () => {
      const algoId = this.nextAlgoId++
      return { algoId }
    })
    this.replies.set('DELETE /fapi/v1/algoOrder', { code: 200, msg: 'success' })
    this.replies.set('DELETE /fapi/v1/order', { orderId: 1, status: 'CANCELED' })
    this.replies.set('PUT /fapi/v1/order', { orderId: 1, status: 'NEW' })
    this.replies.set('GET /fapi/v1/openAlgoOrders', () => this.openAlgo)
    this.replies.set('GET /fapi/v2/positionRisk', () => this.positions)
    this.replies.set('GET /fapi/v1/openOrders', [])
    this.replies.set('GET /fapi/v1/allOrders', [])
    this.replies.set('GET /fapi/v1/userTrades', [])
    this.replies.set('GET /fapi/v2/account', {
      totalWalletBalance: '1000',
      totalMarginBalance: '1010',
      totalUnrealizedProfit: '10',
      availableBalance: '900',
      canTrade: true,
    })
  }

  fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = String(init?.method ?? 'GET')
    const params: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      params[key] = value
    })
    const headers = (init?.headers ?? {}) as Record<string, string>
    const signed = 'signature' in params
    let signatureValid = false
    if (signed) {
      const query = url.search.slice(1).replace(/&signature=[^&]*$/, '')
      signatureValid = createHmac('sha256', API_SECRET).update(query).digest('hex') === params.signature
    }
    const call: Call = { method, path: url.pathname, params, signed, keyHeader: headers['X-MBX-APIKEY'], signatureValid }
    this.calls.push(call)
    const reply = this.replies.get(`${method} ${url.pathname}`)
    if (reply === undefined) return new Response(JSON.stringify({ code: -1, msg: `unhandled ${method} ${url.pathname}` }), { status: 404 })
    const resolved = typeof reply === 'function' ? (reply as (c: Call) => unknown)(call) : reply
    if (isStatusReply(resolved)) return new Response(JSON.stringify(resolved.body), { status: resolved.status })
    return new Response(JSON.stringify(resolved), { status: 200 })
  }

  find(method: string, path: string): Call[] {
    return this.calls.filter(c => c.method === method && c.path === path)
  }
}

function credential(overrides: Partial<BinanceFuturesCredential> = {}): BinanceFuturesCredential {
  return {
    accountId: 'acct-1',
    environment: 'demo',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    marginUsdt: 100,
    leverage: 10,
    marginMode: 'isolated',
    ...overrides,
  }
}

function setup(overrides: Partial<BinanceFuturesCredential> = {}) {
  const fake = new FakeBinance()
  const provider = new BinanceProvider({
    loadCredentials: async () => credential(overrides),
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    sleep: async () => {},
  })
  return { fake, provider }
}

test('signed requests carry the API key and a valid HMAC signature; public ones do not', async () => {
  const { fake, provider } = setup()
  await provider.accountSummary('acct-1')
  const signedCalls = fake.calls.filter(c => c.signed)
  assert.ok(signedCalls.length > 0)
  for (const call of signedCalls) {
    assert.equal(call.keyHeader, API_KEY)
    assert.equal(call.signatureValid, true, `${call.path} signature`)
    assert.equal(call.params.recvWindow, '10000')
    assert.equal(call.params.timestamp, String(NOW))
  }
  assert.ok(fake.calls.filter(c => !c.signed).every(c => c.keyHeader === undefined))
})

test('the demo environment uses the demo-fapi host', async () => {
  const urls: string[] = []
  const client = new BinanceFuturesClient({ apiKey: 'k', apiSecret: 's', environment: 'demo' }, {
    fetchImpl: async input => {
      urls.push(String(input))
      return new Response('{}', { status: 200 })
    },
    now: () => NOW,
  })
  await client.publicGet('/fapi/v1/time')
  assert.ok(urls[0]!.startsWith('https://demo-fapi.binance.com/'))
  const live = new BinanceFuturesClient({ apiKey: 'k', apiSecret: 's', environment: 'live' }, { fetchImpl: async input => {
    urls.push(String(input))
    return new Response('{}', { status: 200 })
  } })
  await live.publicGet('/fapi/v1/time')
  assert.ok(urls[1]!.startsWith('https://fapi.binance.com/'))
})

test('a -1021 clock error resyncs with server time and retries once', async () => {
  let attempts = 0
  const timestamps: string[] = []
  const client = new BinanceFuturesClient({ apiKey: 'k', apiSecret: 's', environment: 'live' }, {
    now: () => NOW,
    fetchImpl: async input => {
      const url = new URL(String(input))
      if (url.pathname === '/fapi/v1/time') return new Response(JSON.stringify({ serverTime: NOW + 5000 }), { status: 200 })
      attempts += 1
      timestamps.push(url.searchParams.get('timestamp') ?? '')
      if (attempts === 1) return new Response(JSON.stringify({ code: -1021, msg: 'Timestamp outside recvWindow' }), { status: 400 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
  })
  const result = await client.signed<{ ok: boolean }>('GET', '/fapi/v2/account')
  assert.equal(result.ok, true)
  assert.equal(attempts, 2)
  assert.equal(timestamps[1], String(NOW + 5000))
})

test('a market buy sets margin type and leverage, sizes from margin x leverage, then places reduce-only stops', async () => {
  const { fake, provider } = setup()
  const result = await provider.orderSend('acct-1', {
    symbol: 'BTCUSDT',
    operation: 'Buy',
    volume: 5,
    stoploss: 64_000,
    takeprofit: 67_000,
    comment: 'TScopier:chan:abcdef12',
  })

  const margin = fake.find('POST', '/fapi/v1/marginType')[0]!
  assert.equal(margin.params.symbol, 'BTCUSDT')
  assert.equal(margin.params.marginType, 'ISOLATED')
  const leverage = fake.find('POST', '/fapi/v1/leverage')[0]!
  assert.equal(leverage.params.leverage, '10')

  const order = fake.find('POST', '/fapi/v1/order')[0]!
  assert.equal(order.params.side, 'BUY')
  assert.equal(order.params.type, 'MARKET')
  // 100 USDT x 10 / 65000 = 0.01538 -> 0.015. The signal volume of 5 is ignored.
  assert.equal(order.params.quantity, '0.015')
  assert.equal(order.params.positionSide, undefined)
  assert.ok(order.params.newClientOrderId!.startsWith('TScopier'))
  assert.ok(order.params.newClientOrderId!.length <= 36)

  const stops = fake.find('POST', '/fapi/v1/algoOrder')
  assert.equal(stops.length, 2)
  const sl = stops.find(c => c.params.type === 'STOP_MARKET')!
  const tp = stops.find(c => c.params.type === 'TAKE_PROFIT_MARKET')!
  for (const stop of [sl, tp]) {
    assert.equal(stop.params.algoType, 'CONDITIONAL')
    assert.equal(stop.params.side, 'SELL')
    assert.equal(stop.params.reduceOnly, 'true')
    assert.equal(stop.params.quantity, '0.015')
    assert.equal(stop.params.workingType, 'MARK_PRICE')
    assert.equal(stop.params.positionSide, undefined)
  }
  assert.equal(sl.params.triggerPrice, '64000.0')
  assert.equal(tp.params.triggerPrice, '67000.0')
  assert.equal(fake.find('POST', '/fapi/v1/order').length, 1, 'stops must not use /fapi/v1/order')

  assert.equal(result.ticket, 9001)
  assert.equal(result.openPrice, 65_000)
  assert.equal(result.stopLoss, 64_000)
  assert.equal(result.takeProfit, 67_000)
  assert.equal(result.lots, 0.015)
})

test('cross margin sends CROSSED and a benign "no change" error is tolerated', async () => {
  const { fake, provider } = setup({ marginMode: 'cross', leverage: 20 })
  fake.replies.set('POST /fapi/v1/marginType', { status: 400, body: { code: -4046, msg: 'No need to change margin type.' } })
  await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Sell' })
  assert.equal(fake.find('POST', '/fapi/v1/marginType')[0]!.params.marginType, 'CROSSED')
  assert.equal(fake.find('POST', '/fapi/v1/leverage')[0]!.params.leverage, '20')
  const order = fake.find('POST', '/fapi/v1/order')[0]!
  assert.equal(order.params.side, 'SELL')
  // 100 x 20 / 64990 = 0.0307 -> 0.030
  assert.equal(order.params.quantity, '0.030')
})

test('leverage and margin type are applied once per symbol, not on every order', async () => {
  const { fake, provider } = setup()
  await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy' })
  await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy' })
  assert.equal(fake.find('POST', '/fapi/v1/leverage').length, 1)
  assert.equal(fake.find('POST', '/fapi/v1/marginType').length, 1)
  assert.equal(fake.find('POST', '/fapi/v1/order').length, 2)
})

test('a rejected margin type that is not benign fails the order before it is placed', async () => {
  const { fake, provider } = setup()
  fake.replies.set('POST /fapi/v1/marginType', { status: 400, body: { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' } })
  await assert.rejects(provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy' }), /rejected isolated margin/)
  assert.equal(fake.find('POST', '/fapi/v1/order').length, 0)
})

test('hedge mode sends positionSide and omits reduceOnly on the order and stops', async () => {
  const { fake, provider } = setup()
  fake.hedge = true
  await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy', stoploss: 64_000 })
  const order = fake.find('POST', '/fapi/v1/order')[0]!
  assert.equal(order.params.positionSide, 'LONG')
  const stop = fake.find('POST', '/fapi/v1/algoOrder')[0]!
  assert.equal(stop.params.positionSide, 'LONG')
  assert.equal(stop.params.reduceOnly, undefined)
})

test('XAUUSD maps to XAUUSDT and an unknown symbol is rejected', async () => {
  const { fake, provider } = setup()
  fake.replies.set('GET /fapi/v1/ticker/bookTicker', { symbol: 'XAUUSDT', bidPrice: '2400.00', askPrice: '2400.50' })
  const result = await provider.orderSend('acct-1', { volume: 5, symbol: 'XAUUSD', operation: 'Buy' })
  assert.equal(result.symbol, 'XAUUSDT')
  assert.equal(fake.find('POST', '/fapi/v1/order')[0]!.params.symbol, 'XAUUSDT')
  await assert.rejects(provider.orderSend('acct-1', { volume: 5, symbol: 'NOPEUSD', operation: 'Buy' }), /not available on Binance futures/)
})

test('an order below the minimum notional is refused without calling Binance to trade', async () => {
  const { fake, provider } = setup({ marginUsdt: 5, leverage: 2 })
  await assert.rejects(provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy' }), /minimum order/)
  assert.equal(fake.find('POST', '/fapi/v1/order').length, 0)
  assert.equal(fake.find('POST', '/fapi/v1/leverage').length, 0)
})

test('a limit order is placed as GTC at the signal price and tracked as pending', async () => {
  const { fake, provider } = setup()
  const result = await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'BuyLimit', price: 64_000.04 })
  const order = fake.find('POST', '/fapi/v1/order')[0]!
  assert.equal(order.params.type, 'LIMIT')
  assert.equal(order.params.timeInForce, 'GTC')
  assert.equal(order.params.price, '64000.0')
  assert.equal(result.state, 'Placed')
  await assert.rejects(provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'BuyStop', price: 66_000 }), /does not support BuyStop/)
})

test('if the stop loss cannot be placed the new position is closed immediately', async () => {
  const { fake, provider } = setup()
  fake.replies.set('POST /fapi/v1/algoOrder', { status: 400, body: { code: -4120, msg: 'Order type not supported for this endpoint.' } })
  await assert.rejects(
    provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy', stoploss: 64_000 }),
    /position was closed/,
  )
  const orders = fake.find('POST', '/fapi/v1/order')
  assert.equal(orders.length, 2)
  assert.equal(orders[1]!.params.side, 'SELL')
  assert.equal(orders[1]!.params.reduceOnly, 'true')
  assert.equal(orders[1]!.params.quantity, '0.015')
})

test('a failed take profit leaves the position open and protected by its stop loss', async () => {
  const { fake, provider } = setup()
  let algoCalls = 0
  fake.replies.set('POST /fapi/v1/algoOrder', () => {
    algoCalls += 1
    if (algoCalls === 2) return { status: 400, body: { code: -2021, msg: 'Order would immediately trigger.' } }
    return { algoId: 7000 + algoCalls }
  })
  const result = await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy', stoploss: 64_000, takeprofit: 60_000 })
  assert.equal(fake.find('POST', '/fapi/v1/order').length, 1)
  assert.equal(result.stopLoss, 64_000)
  assert.equal(result.takeProfit, undefined)
})

test('modify replaces the stop loss: cancels the old algo order and places a new reduce-only one', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy', stoploss: 64_000 })
  const oldAlgoId = 5001
  const modified = await provider.orderModify('acct-1', { ticket: placed.ticket!, stoploss: 64_500 })
  const deletes = fake.find('DELETE', '/fapi/v1/algoOrder')
  assert.equal(deletes.length, 1)
  assert.equal(deletes[0]!.params.algoId, String(oldAlgoId))
  const stops = fake.find('POST', '/fapi/v1/algoOrder')
  assert.equal(stops.length, 2)
  assert.equal(stops[1]!.params.triggerPrice, '64500.0')
  assert.equal(stops[1]!.params.reduceOnly, 'true')
  assert.equal(modified.stopLoss, 64_500)
})

test('modify with stoploss 0 removes the stop without placing a new one', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy', stoploss: 64_000 })
  const modified = await provider.orderModify('acct-1', { ticket: placed.ticket!, stoploss: 0 })
  assert.equal(fake.find('DELETE', '/fapi/v1/algoOrder').length, 1)
  assert.equal(fake.find('POST', '/fapi/v1/algoOrder').length, 1)
  assert.equal(modified.stopLoss, undefined)
})

test('close sends a reduce-only market order, cancels the stops and reports realized profit', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy', stoploss: 64_000, takeprofit: 67_000 })
  fake.bid = 65_500
  fake.replies.set('GET /fapi/v1/userTrades', [
    { orderId: 9002, realizedPnl: '7.5', commission: '0.02' },
  ])
  const closed = await provider.orderClose('acct-1', { ticket: placed.ticket! })

  const orders = fake.find('POST', '/fapi/v1/order')
  assert.equal(orders.length, 2)
  const close = orders[1]!
  assert.equal(close.params.side, 'SELL')
  assert.equal(close.params.type, 'MARKET')
  assert.equal(close.params.reduceOnly, 'true')
  assert.equal(close.params.quantity, '0.015')
  assert.ok(close.params.newClientOrderId!.startsWith(`TSX:${placed.ticket}:`))

  assert.equal(fake.find('DELETE', '/fapi/v1/algoOrder').length, 2)
  assert.equal(closed.state, 'position_closed')
  assert.equal(closed.closePrice, 65_500)
  assert.equal(closed.profit, 7.5)
  assert.equal(closed.commission, -0.02)
  await assert.rejects(provider.orderClose('acct-1', { ticket: placed.ticket! }), /was not found/)
})

test('a partial close reduces the leg and re-places the stops for the remaining quantity', async () => {
  const { fake, provider } = setup({ marginUsdt: 200 })
  const placed = await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy', stoploss: 64_000 })
  // 200 x 10 / 65000 = 0.0307 -> 0.030
  assert.equal(placed.lots, 0.03)
  const closed = await provider.orderClose('acct-1', { ticket: placed.ticket!, lots: 0.01 })
  const close = fake.find('POST', '/fapi/v1/order')[1]!
  assert.equal(close.params.quantity, '0.010')
  assert.equal(closed.lots, 0.01)
  const stops = fake.find('POST', '/fapi/v1/algoOrder')
  assert.equal(stops.length, 2)
  assert.equal(stops[1]!.params.quantity, '0.020')
})

test('closing a pending limit order cancels it on Binance', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'BuyLimit', price: 64_000 })
  const closed = await provider.orderClose('acct-1', { ticket: placed.ticket! })
  assert.equal(fake.find('DELETE', '/fapi/v1/order').length, 1)
  assert.equal(closed.state, 'position_closed')
})

test('openedOrders lists live legs and drops a leg once its stop fired, cancelling the take profit', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { volume: 5, symbol: 'BTCUSDT', operation: 'Buy', stoploss: 64_000, takeprofit: 67_000 })
  fake.positions = [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.015', entryPrice: '65000', markPrice: '65100' }]
  fake.openAlgo = [
    { algoId: 5001, clientAlgoId: `TSL:${placed.ticket}:abcd`, triggerPrice: '64000' },
    { algoId: 5002, clientAlgoId: `TST:${placed.ticket}:abcd`, triggerPrice: '67000' },
  ]
  const live = await provider.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(live.length, 1)
  assert.equal(live[0]!.ticket, placed.ticket)
  assert.equal(live[0]!.operation, 'Buy')
  assert.equal(live[0]!.stopLoss, 64_000)
  assert.equal(live[0]!.takeProfit, 67_000)

  // The stop fires: the position closes and its algo order leaves the open list.
  fake.positions = []
  fake.openAlgo = [{ algoId: 5002, clientAlgoId: `TST:${placed.ticket}:abcd`, triggerPrice: '67000' }]
  const after = await provider.openedOrders('acct-1')
  assert.equal(after.length, 0)
  const cancelled = fake.find('DELETE', '/fapi/v1/algoOrder').map(c => c.params.algoId)
  assert.ok(cancelled.includes('5002'), 'the surviving take profit must be cancelled')
})

test('legs are rebuilt from Binance after a restart using copier client ids and stop orders', async () => {
  const { fake, provider } = setup()
  fake.positions = [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.015', entryPrice: '65000', markPrice: '65100' }]
  fake.openAlgo = [{ algoId: 6001, clientAlgoId: 'TSL:8123:wxyz', triggerPrice: '64000' }]
  fake.replies.set('GET /fapi/v1/allOrders', [
    { orderId: 8123, clientOrderId: 'TScopier:abcdef12:q1w2', status: 'FILLED', side: 'BUY', executedQty: '0.015', avgPrice: '65000', time: NOW - 1000, positionSide: 'BOTH' },
    { orderId: 8000, clientOrderId: 'manual-order', status: 'FILLED', side: 'BUY', executedQty: '1', avgPrice: '60000', time: NOW - 5000, positionSide: 'BOTH' },
  ])
  const live = await provider.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(live.length, 1)
  assert.equal(live[0]!.ticket, 8123)
  assert.equal(live[0]!.lots, 0.015)
  assert.equal(live[0]!.stopLoss, 64_000)
})

test('accountSummary maps Binance futures balances to the copier summary', async () => {
  const { provider } = setup()
  const summary = await provider.accountSummary('acct-1')
  assert.equal(summary.balance, 1000)
  assert.equal(summary.equity, 1010)
  assert.equal(summary.profit, 10)
  assert.equal(summary.freeMargin, 900)
  assert.equal(summary.currency, 'USDT')
  assert.equal(summary.leverage, 10)
})

test('a provider with no credentials reports Binance is not configured', async () => {
  const provider = new BinanceProvider({ loadCredentials: async () => null, fetchImpl: new FakeBinance().fetchImpl })
  await assert.rejects(provider.accountSummary('missing'), /Binance is not configured/)
  assert.equal(await provider.keepSessionAlive('missing'), false)
})

test('Binance API errors keep their code so callers can classify them', async () => {
  const { fake, provider } = setup()
  fake.replies.set('GET /fapi/v2/account', { status: 401, body: { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' } })
  await assert.rejects(provider.accountSummary('acct-1'), (error: unknown) => error instanceof BinanceApiError && error.code === -2015)
  assert.equal(await provider.keepSessionAliveDetailed('acct-1'), 'token_reconnect_failed')
})
