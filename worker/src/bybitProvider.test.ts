import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { BybitProvider } from './bybitProvider'
import { ticketToken } from './bybit/symbols'
import {
  BybitApiError,
  BybitClient,
  buildBody,
  signPayload,
  type BybitCredential,
} from './bybit/client'

const API_KEY = 'test-api-key'
const API_SECRET = 'test-api-secret'
const NOW = 1_790_000_000_000

const instruments = {
  list: [
    {
      symbol: 'BTCUSDT',
      contractType: 'LinearPerpetual',
      status: 'Trading',
      settleCoin: 'USDT',
      priceFilter: { tickSize: '0.10' },
      lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', maxMktOrderQty: '50', minNotionalValue: '5' },
      leverageFilter: { minLeverage: '1', maxLeverage: '100', leverageStep: '0.01' },
    },
    {
      symbol: 'XAUUSDT',
      contractType: 'LinearPerpetual',
      status: 'Trading',
      settleCoin: 'USDT',
      priceFilter: { tickSize: '0.01' },
      lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01', maxOrderQty: '1000', maxMktOrderQty: '500', minNotionalValue: '5' },
      leverageFilter: { minLeverage: '1', maxLeverage: '50', leverageStep: '0.01' },
    },
  ],
  nextPageCursor: '',
}

type Call = {
  method: string
  path: string
  params: Record<string, string>
  body: Record<string, unknown>
  signed: boolean
  apiKey?: string
  timestamp?: string
  recvWindow?: string
  signatureValid: boolean
}

type Reply = unknown | ((call: Call) => unknown)
type Raw = { rawStatus: number; rawBody: string }

function ok(result: unknown) {
  return { retCode: 0, retMsg: 'OK', result, retExtInfo: {}, time: NOW }
}

function fail(retCode: number, retMsg: string) {
  return { retCode, retMsg, result: {}, retExtInfo: {}, time: NOW }
}

function isRaw(value: unknown): value is Raw {
  return !!value && typeof value === 'object' && 'rawStatus' in value
}

class FakeBybit {
  calls: Call[] = []
  replies = new Map<string, Reply>()
  nextOrder = 1
  ask = 65_000
  bid = 64_990
  hedge = false
  unifiedStatus = 4
  marginMode = 'REGULAR_MARGIN'
  marketOutcome: 'fill' | 'dead' = 'fill'
  orders = new Map<string, Record<string, unknown>>()
  history: Array<Record<string, unknown>> = []
  stopOrders: Array<Record<string, unknown>> = []
  openLimits: Array<Record<string, unknown>> = []
  positions: Array<Record<string, unknown>> = []
  closedPnl: Array<Record<string, unknown>> = []

  constructor() {
    this.replies.set('GET /v5/market/time', ok({ timeSecond: String(Math.floor(NOW / 1000)) }))
    this.replies.set('GET /v5/market/instruments-info', ok(instruments))
    this.replies.set('GET /v5/market/tickers', () => ok({
      list: [{ symbol: 'BTCUSDT', bid1Price: String(this.bid), ask1Price: String(this.ask) }],
    }))
    this.replies.set('GET /v5/account/info', () => ok({ unifiedMarginStatus: this.unifiedStatus, marginMode: this.marginMode }))
    this.replies.set('GET /v5/account/wallet-balance', ok({
      list: [{
        totalEquity: '1010',
        totalWalletBalance: '1000',
        totalMarginBalance: '1010',
        totalAvailableBalance: '900',
        totalPerpUPL: '10',
        totalInitialMargin: '100',
      }],
    }))
    this.replies.set('POST /v5/position/set-leverage', ok({}))
    this.replies.set('POST /v5/order/amend', ok({ orderId: 'x' }))
    this.replies.set('GET /v5/position/closed-pnl', () => ok({ list: this.closedPnl, nextPageCursor: '' }))
    this.replies.set('GET /v5/order/history', (call: Call) => {
      let rows = this.history
      if (call.params.orderId) rows = rows.filter(row => row.orderId === call.params.orderId)
      if (call.params.symbol) rows = rows.filter(row => row.symbol === call.params.symbol)
      return ok({ list: rows, nextPageCursor: '' })
    })
    this.replies.set('GET /v5/order/realtime', (call: Call) => {
      if (call.params.orderId) {
        const order = this.orders.get(call.params.orderId)
        return ok({ list: order ? [order] : [], nextPageCursor: '' })
      }
      if (call.params.orderFilter === 'StopOrder') {
        return ok({ list: call.params.settleCoin === 'USDT' ? this.stopOrders : [], nextPageCursor: '' })
      }
      return ok({ list: call.params.settleCoin === 'USDT' ? this.openLimits : [], nextPageCursor: '' })
    })
    this.replies.set('GET /v5/position/list', (call: Call) => {
      if (call.params.symbol) {
        const rows = this.positions.filter(row => row.symbol === call.params.symbol)
        if (rows.length > 0) return ok({ list: rows, nextPageCursor: '' })
        return ok({
          list: this.hedge
            ? [{ symbol: call.params.symbol, positionIdx: 1, side: '', size: '0' }, { symbol: call.params.symbol, positionIdx: 2, side: '', size: '0' }]
            : [{ symbol: call.params.symbol, positionIdx: 0, side: '', size: '0' }],
          nextPageCursor: '',
        })
      }
      return ok({ list: call.params.settleCoin === 'USDT' ? this.positions : [], nextPageCursor: '' })
    })
    this.replies.set('POST /v5/order/cancel', (call: Call) => {
      const orderId = String(call.body.orderId ?? '')
      const before = this.stopOrders.length + this.openLimits.length
      this.stopOrders = this.stopOrders.filter(order => order.orderId !== orderId)
      this.openLimits = this.openLimits.filter(order => order.orderId !== orderId)
      if (before === this.stopOrders.length + this.openLimits.length) return fail(110001, 'Order does not exist')
      return ok({ orderId })
    })
    this.replies.set('POST /v5/order/create', (call: Call) => this.create(call))
  }

  private adjustPosition(symbol: string, side: string, qty: number, price: number, reduceOnly: boolean, idx: number) {
    const positionSide = reduceOnly ? (side === 'Buy' ? 'Sell' : 'Buy') : side
    const existing = this.positions.find(row => row.symbol === symbol && row.side === positionSide)
    if (reduceOnly) {
      if (!existing) return
      const left = Number(existing.size) - qty
      if (left <= 1e-12) this.positions = this.positions.filter(row => row !== existing)
      else existing.size = String(left)
      return
    }
    if (existing) {
      existing.size = String(Number(existing.size) + qty)
    } else {
      this.positions.push({ symbol, side: positionSide, size: String(qty), avgPrice: String(price), markPrice: String(price), positionIdx: idx })
    }
  }

  private create(call: Call) {
    const body = call.body
    const orderId = `ord-${this.nextOrder++}`
    const symbol = String(body.symbol)
    const side = String(body.side)
    const qty = Number(body.qty)
    const common = {
      orderId,
      orderLinkId: String(body.orderLinkId ?? ''),
      symbol,
      side,
      qty: String(body.qty),
      price: String(body.price ?? '0'),
      positionIdx: body.positionIdx ?? 0,
      reduceOnly: body.reduceOnly === true,
      createdTime: String(NOW),
    }
    if (body.triggerPrice !== undefined) {
      this.stopOrders.push({ ...common, triggerPrice: String(body.triggerPrice), orderStatus: 'Untriggered' })
      return ok({ orderId, orderLinkId: common.orderLinkId })
    }
    if (body.orderType === 'Limit') {
      const order = { ...common, orderStatus: 'New', cumExecQty: '0', avgPrice: '' }
      this.orders.set(orderId, order)
      this.openLimits.push(order)
      return ok({ orderId, orderLinkId: common.orderLinkId })
    }
    const price = side === 'Buy' ? this.ask : this.bid
    if (this.marketOutcome === 'dead') {
      const order = { ...common, orderStatus: 'Cancelled', cumExecQty: '0', avgPrice: '', cancelType: 'CancelByPrice' }
      this.orders.set(orderId, order)
      return ok({ orderId, orderLinkId: common.orderLinkId })
    }
    const order = { ...common, orderStatus: 'Filled', cumExecQty: String(qty), avgPrice: String(price) }
    this.orders.set(orderId, order)
    this.history.push(order)
    this.adjustPosition(symbol, side, qty, price, body.reduceOnly === true, Number(body.positionIdx ?? 0))
    if (body.reduceOnly === true) {
      this.closedPnl.push({
        orderId,
        symbol,
        side,
        closedSize: String(qty),
        avgEntryPrice: '65000',
        avgExitPrice: String(price),
        closedPnl: '12.5',
        openFee: '0.1',
        closeFee: '0.2',
        createdTime: String(NOW),
        updatedTime: String(NOW),
      })
    }
    return ok({ orderId, orderLinkId: common.orderLinkId })
  }

  fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = String(init?.method ?? 'GET')
    const params: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      params[key] = value
    })
    const headers = (init?.headers ?? {}) as Record<string, string>
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {}
    const signed = headers['X-BAPI-SIGN'] !== undefined
    let signatureValid = false
    if (signed) {
      const payload = method === 'GET' ? url.search.slice(1) : rawBody
      const expected = createHmac('sha256', API_SECRET)
        .update(`${headers['X-BAPI-TIMESTAMP']}${headers['X-BAPI-API-KEY']}${headers['X-BAPI-RECV-WINDOW']}${payload}`)
        .digest('hex')
      signatureValid = expected === headers['X-BAPI-SIGN']
    }
    const call: Call = {
      method,
      path: url.pathname,
      params,
      body,
      signed,
      apiKey: headers['X-BAPI-API-KEY'],
      timestamp: headers['X-BAPI-TIMESTAMP'],
      recvWindow: headers['X-BAPI-RECV-WINDOW'],
      signatureValid,
    }
    this.calls.push(call)
    const reply = this.replies.get(`${method} ${url.pathname}`)
    if (reply === undefined) return new Response(JSON.stringify(fail(-1, `unhandled ${method} ${url.pathname}`)), { status: 404 })
    const resolved = typeof reply === 'function' ? (reply as (c: Call) => unknown)(call) : reply
    if (isRaw(resolved)) return new Response(resolved.rawBody, { status: resolved.rawStatus })
    return new Response(JSON.stringify(resolved), { status: 200 })
  }

  find(method: string, path: string): Call[] {
    return this.calls.filter(c => c.method === method && c.path === path)
  }
}

function credential(overrides: Partial<BybitCredential> = {}): BybitCredential {
  return {
    accountId: 'acct-1',
    environment: 'demo',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    marginUsdt: 100,
    leverage: 10,
    ...overrides,
  }
}

function setup(overrides: Partial<BybitCredential> = {}) {
  const fake = new FakeBybit()
  const make = () => new BybitProvider({
    loadCredentials: async () => credential(overrides),
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    sleep: async () => {},
  })
  return { fake, provider: make(), make }
}

const BUY = { symbol: 'BTCUSDT', operation: 'Buy', volume: 5, comment: 'TScopier:chan:abcdef12' } as const

// ── Signing and transport ───────────────────────────────────────────────────

test('signPayload signs timestamp + apiKey + recvWindow + payload as lowercase hex', () => {
  const timestamp = '1658384314791'
  const query = 'category=option&symbol=BTC-29JUL22-25000-C'
  const plain = `${timestamp}XXXXXXXXXX5000${query}`
  const expected = createHmac('sha256', 'secret').update(plain).digest('hex')
  const got = signPayload('secret', timestamp, 'XXXXXXXXXX', 5000, query)
  assert.equal(got, expected)
  assert.match(got, /^[0-9a-f]{64}$/)
  // POST bodies are signed as the exact JSON string that is sent.
  const body = buildBody({ category: 'option' })
  assert.equal(body, '{"category":"option"}')
  assert.equal(
    signPayload('secret', '1658385579423', 'XXXXXXXXXX', 5000, body),
    createHmac('sha256', 'secret').update('1658385579423XXXXXXXXXX5000{"category":"option"}').digest('hex'),
  )
})

test('signed GET and POST requests carry the key headers and a valid signature; public ones do not', async () => {
  const { fake, provider } = setup()
  await provider.accountSummary('acct-1')
  await provider.orderSend('acct-1', BUY)
  const signedGet = fake.calls.find(c => c.signed && c.method === 'GET')!
  const signedPost = fake.calls.find(c => c.signed && c.method === 'POST')!
  for (const call of [signedGet, signedPost]) {
    assert.equal(call.apiKey, API_KEY)
    assert.equal(call.recvWindow, '10000')
    assert.equal(call.timestamp, String(NOW))
    assert.equal(call.signatureValid, true, `${call.method} ${call.path} signature`)
  }
  assert.ok(fake.calls.filter(c => !c.signed).every(c => c.apiKey === undefined))
  assert.ok(fake.calls.some(c => !c.signed && c.path === '/v5/market/instruments-info'))
})

test('the demo environment uses api-demo.bybit.com and live uses api.bybit.com', async () => {
  const urls: string[] = []
  const reply = async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input))
    return new Response(JSON.stringify(ok({})), { status: 200 })
  }
  await new BybitClient({ apiKey: 'k', apiSecret: 's', environment: 'demo' }, { fetchImpl: reply }).publicGet('/v5/market/time')
  await new BybitClient({ apiKey: 'k', apiSecret: 's', environment: 'live' }, { fetchImpl: reply }).publicGet('/v5/market/time')
  assert.ok(urls[0]!.startsWith('https://api-demo.bybit.com/'))
  assert.ok(urls[1]!.startsWith('https://api.bybit.com/'))
})

test('a retCode error inside an HTTP 200 reply is thrown with its code', async () => {
  const client = new BybitClient({ apiKey: 'k', apiSecret: 's', environment: 'live' }, {
    now: () => NOW,
    fetchImpl: async () => new Response(JSON.stringify(fail(10003, 'API key is invalid.')), { status: 200 }),
  })
  await assert.rejects(
    client.signed('GET', '/v5/account/info'),
    (error: unknown) => error instanceof BybitApiError && error.code === 10003 && /invalid/i.test(error.message),
  )
})

test('a 10002 timestamp error resyncs with server time and retries once', async () => {
  let attempts = 0
  const timestamps: string[] = []
  const client = new BybitClient({ apiKey: 'k', apiSecret: 's', environment: 'live' }, {
    now: () => NOW,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/v5/market/time') {
        return new Response(JSON.stringify({ ...ok({}), time: NOW + 5000 }), { status: 200 })
      }
      attempts += 1
      timestamps.push((init?.headers as Record<string, string>)['X-BAPI-TIMESTAMP'] ?? '')
      if (attempts === 1) return new Response(JSON.stringify(fail(10002, 'The request time exceeds the time window range.')), { status: 200 })
      return new Response(JSON.stringify(ok({ done: true })), { status: 200 })
    },
  })
  const result = await client.signed<{ done: boolean }>('GET', '/v5/account/info')
  assert.equal(result.done, true)
  assert.equal(attempts, 2)
  assert.equal(timestamps[1], String(NOW + 5000))
})

test('an HTTP 403 explains the region block', async () => {
  const client = new BybitClient({ apiKey: 'k', apiSecret: 's', environment: 'live' }, {
    fetchImpl: async () => new Response('blocked by CloudFront', { status: 403 }),
  })
  await assert.rejects(client.publicGet('/v5/market/time'), (error: unknown) =>
    error instanceof BybitApiError && error.status === 403 && /region|US or mainland China/i.test(error.message))
})

// ── Entry, sizing and stops ─────────────────────────────────────────────────

test('a market buy sets leverage, sizes from margin x leverage, then places reduce-only conditional stops', async () => {
  const { fake, provider } = setup()
  const result = await provider.orderSend('acct-1', { ...BUY, stoploss: 64_000, takeprofit: 67_000 })

  const leverage = fake.find('POST', '/v5/position/set-leverage')[0]!
  assert.equal(leverage.body.symbol, 'BTCUSDT')
  assert.equal(leverage.body.buyLeverage, '10')
  assert.equal(leverage.body.sellLeverage, '10')
  assert.equal(fake.find('POST', '/v5/account/set-margin-mode').length, 0, 'margin mode is never changed')

  const creates = fake.find('POST', '/v5/order/create')
  const entry = creates[0]!
  assert.equal(entry.body.category, 'linear')
  assert.equal(entry.body.side, 'Buy')
  assert.equal(entry.body.orderType, 'Market')
  // 100 USDT x 10 / 65000 = 0.01538 -> 0.015. The signal volume of 5 is ignored.
  assert.equal(entry.body.qty, '0.015')
  assert.equal(entry.body.positionIdx, 0)
  const linkId = String(entry.body.orderLinkId)
  assert.ok(linkId.startsWith('TScopier'))
  assert.ok(linkId.length <= 36)
  assert.match(linkId, /^[A-Za-z0-9_-]+$/)

  const stops = creates.slice(1)
  assert.equal(stops.length, 2)
  const sl = stops.find(c => String(c.body.orderLinkId).startsWith('TSL_'))!
  const tp = stops.find(c => String(c.body.orderLinkId).startsWith('TST_'))!
  for (const stop of [sl, tp]) {
    assert.equal(stop.body.side, 'Sell')
    assert.equal(stop.body.orderType, 'Market')
    assert.equal(stop.body.reduceOnly, true)
    assert.equal(stop.body.closeOnTrigger, true)
    assert.equal(stop.body.triggerBy, 'MarkPrice')
    assert.equal(stop.body.qty, '0.015')
    assert.equal(stop.body.positionIdx, 0)
  }
  // A long's stop fires when price falls (2) and its target when price rises (1).
  assert.equal(sl.body.triggerDirection, 2)
  assert.equal(tp.body.triggerDirection, 1)
  assert.equal(sl.body.triggerPrice, '64000.0')
  assert.equal(tp.body.triggerPrice, '67000.0')

  assert.ok(Number.isSafeInteger(result.ticket) && result.ticket! > 1e10)
  assert.ok(linkId.endsWith(`_${ticketToken(result.ticket!)}`))
  assert.equal(result.comment, 'TScopier:abcdef12')
  assert.equal(result.openPrice, 65_000)
  assert.equal(result.stopLoss, 64_000)
  assert.equal(result.takeProfit, 67_000)
  assert.equal(result.lots, 0.015)
})

test('a market sell flips the stop trigger directions', async () => {
  const { fake, provider } = setup()
  await provider.orderSend('acct-1', { symbol: 'BTCUSDT', operation: 'Sell', volume: 1, stoploss: 66_000, takeprofit: 63_000 })
  const stops = fake.find('POST', '/v5/order/create').slice(1)
  const sl = stops.find(c => String(c.body.orderLinkId).startsWith('TSL_'))!
  const tp = stops.find(c => String(c.body.orderLinkId).startsWith('TST_'))!
  assert.equal(sl.body.side, 'Buy')
  assert.equal(sl.body.triggerDirection, 1)
  assert.equal(tp.body.triggerDirection, 2)
})

test('leverage is set once per symbol and a "not modified" error (110043) is tolerated', async () => {
  const { fake, provider } = setup()
  fake.replies.set('POST /v5/position/set-leverage', fail(110043, 'Set leverage has not been modified.'))
  await provider.orderSend('acct-1', BUY)
  await provider.orderSend('acct-1', { ...BUY, comment: 'TScopier:chan:00112233' })
  assert.equal(fake.find('POST', '/v5/position/set-leverage').length, 1)
  assert.equal(fake.find('POST', '/v5/order/create').length, 2)
})

test('any other set-leverage error rejects the order before it is placed', async () => {
  const { fake, provider } = setup()
  fake.replies.set('POST /v5/position/set-leverage', fail(110013, 'Parameter error: leverage invalid'))
  await assert.rejects(provider.orderSend('acct-1', BUY), /rejected 10x leverage/i)
  assert.equal(fake.find('POST', '/v5/order/create').length, 0)
})

test('leverage above the symbol maximum is rejected', async () => {
  const { fake, provider } = setup({ leverage: 75 })
  await assert.rejects(provider.orderSend('acct-1', { symbol: 'XAUUSD', operation: 'Buy', volume: 1 }), /maximum of 50x/)
  assert.equal(fake.find('POST', '/v5/order/create').length, 0)
})

test('XAUUSD resolves to XAUUSDT and sizes from the ticker price', async () => {
  const { fake, provider } = setup()
  fake.replies.set('GET /v5/market/tickers', () => ok({ list: [{ symbol: 'XAUUSDT', bid1Price: '2000', ask1Price: '2001' }] }))
  const result = await provider.orderSend('acct-1', { symbol: 'XAUUSD', operation: 'Buy', volume: 1 })
  const entry = fake.find('POST', '/v5/order/create')[0]!
  assert.equal(entry.body.symbol, 'XAUUSDT')
  // 100 x 10 / 2001 = 0.4997 -> 0.49
  assert.equal(entry.body.qty, '0.49')
  assert.equal(result.symbol, 'XAUUSDT')
})

test('a market order is capped at the symbol market maximum', async () => {
  const { fake, provider } = setup({ marginUsdt: 100_000_000, leverage: 10 })
  await provider.orderSend('acct-1', BUY)
  assert.equal(fake.find('POST', '/v5/order/create')[0]!.body.qty, '50.000')
})

test('a margin below the exchange minimum notional is rejected with a clear message', async () => {
  const { fake, provider } = setup({ marginUsdt: 0.1, leverage: 1 })
  await assert.rejects(provider.orderSend('acct-1', BUY), /below the Bybit minimum order for BTCUSDT/)
  assert.equal(fake.find('POST', '/v5/order/create').length, 0)
})

test('hedge mode sends positionIdx 1 for buys and 2 for sells, including on the stops', async () => {
  const { fake, provider } = setup()
  fake.hedge = true
  await provider.orderSend('acct-1', { ...BUY, stoploss: 64_000 })
  await provider.orderSend('acct-1', { symbol: 'BTCUSDT', operation: 'Sell', volume: 1, stoploss: 66_000 })
  const creates = fake.find('POST', '/v5/order/create')
  assert.equal(creates[0]!.body.positionIdx, 1)
  assert.equal(creates[1]!.body.positionIdx, 1, 'buy stop')
  assert.equal(creates[2]!.body.positionIdx, 2)
  assert.equal(creates[3]!.body.positionIdx, 2, 'sell stop')
})

test('a market order that Bybit cancels with nothing filled is reported, not recorded', async () => {
  const { fake, provider } = setup()
  fake.marketOutcome = 'dead'
  await assert.rejects(provider.orderSend('acct-1', { ...BUY, stoploss: 64_000 }), /did not fill/i)
  assert.equal(fake.find('POST', '/v5/order/create').length, 1, 'no stop placed for a dead order')
  assert.deepEqual(await provider.openedOrders('acct-1'), [])
})

test('when the stop loss is rejected the position is closed straight away', async () => {
  const { fake, provider } = setup()
  const original = fake.replies.get('POST /v5/order/create')!
  fake.replies.set('POST /v5/order/create', (call: Call) => {
    if (call.body.triggerPrice !== undefined) return fail(110017, 'stop rejected')
    return (original as (c: Call) => unknown)(call)
  })
  await assert.rejects(provider.orderSend('acct-1', { ...BUY, stoploss: 64_000 }), /position was closed/)
  const creates = fake.find('POST', '/v5/order/create')
  const emergency = creates[creates.length - 1]!
  assert.equal(emergency.body.reduceOnly, true)
  assert.equal(emergency.body.side, 'Sell')
  assert.ok(String(emergency.body.orderLinkId).startsWith('TSX_'))
  assert.equal(fake.positions.length, 0)
})

// ── Pending limits ──────────────────────────────────────────────────────────

test('a limit order stays pending, can be amended, and is cancelled on close', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { symbol: 'BTCUSDT', operation: 'BuyLimit', price: 60_000, volume: 1 })
  const entry = fake.find('POST', '/v5/order/create')[0]!
  assert.equal(entry.body.orderType, 'Limit')
  assert.equal(entry.body.timeInForce, 'GTC')
  assert.equal(entry.body.price, '60000.0')
  // 100 x 10 / 60000 = 0.0166 -> 0.016
  assert.equal(entry.body.qty, '0.016')
  assert.equal(placed.state, 'Placed')

  let opened = await provider.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(opened.length, 1)
  assert.equal(opened[0]!.operation, 'BuyLimit')

  await provider.orderModify('acct-1', { ticket: placed.ticket!, price: 59_000 } as never)
  const amend = fake.find('POST', '/v5/order/amend')[0]!
  assert.equal(amend.body.price, '59000.0')
  assert.equal(amend.body.orderId, 'ord-1')

  await provider.orderClose('acct-1', { ticket: placed.ticket! } as never)
  assert.equal(fake.find('POST', '/v5/order/cancel')[0]!.body.orderId, 'ord-1')
  opened = await provider.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(opened.length, 0)
})

// ── Modify and close ────────────────────────────────────────────────────────

test('modifying stops cancels the old order and places the new trigger; 0 removes it', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { ...BUY, stoploss: 64_000, takeprofit: 67_000 })
  const oldSl = fake.stopOrders.find(o => String(o.orderLinkId).startsWith('TSL_'))!.orderId

  await provider.orderModify('acct-1', { ticket: placed.ticket!, stoploss: 64_500 } as never)
  assert.equal(fake.find('POST', '/v5/order/cancel')[0]!.body.orderId, oldSl)
  const sls = fake.stopOrders.filter(o => String(o.orderLinkId).startsWith('TSL_'))
  assert.equal(sls.length, 1)
  assert.equal(sls[0]!.triggerPrice, '64500.0')
  assert.equal(fake.stopOrders.filter(o => String(o.orderLinkId).startsWith('TST_')).length, 1, 'take profit untouched')

  const removed = await provider.orderModify('acct-1', { ticket: placed.ticket!, takeprofit: 0 } as never)
  assert.equal(fake.stopOrders.filter(o => String(o.orderLinkId).startsWith('TST_')).length, 0)
  assert.equal(removed.takeProfit, undefined)
})

test('a full close sends a reduce-only market order, cancels the stops and returns realized profit', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { ...BUY, stoploss: 64_000, takeprofit: 67_000 })
  const closed = await provider.orderClose('acct-1', { ticket: placed.ticket! } as never)

  const close = fake.find('POST', '/v5/order/create').find(c => String(c.body.orderLinkId).startsWith('TSX_'))!
  assert.equal(close.body.side, 'Sell')
  assert.equal(close.body.orderType, 'Market')
  assert.equal(close.body.reduceOnly, true)
  assert.equal(close.body.qty, '0.015')
  assert.equal(fake.stopOrders.length, 0)
  assert.equal(closed.profit, 12.5)
  assert.ok(Math.abs((closed.commission ?? 0) + 0.3) < 1e-9)
  assert.equal(closed.closePrice, 64_990)
  assert.deepEqual(await provider.openedOrders('acct-1'), [])
})

test('a partial close trims the leg and rebuilds the stops at the smaller size', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { symbol: 'BTCUSDT', operation: 'Buy', volume: 1, stoploss: 64_000, takeprofit: 67_000 })
  await provider.orderClose('acct-1', { ticket: placed.ticket!, lots: 0.005 } as never)

  const close = fake.find('POST', '/v5/order/create').find(c => String(c.body.orderLinkId).startsWith('TSX_'))!
  assert.equal(close.body.qty, '0.005')
  assert.equal(close.body.reduceOnly, true)
  const stops = fake.stopOrders
  assert.equal(stops.length, 2)
  for (const stop of stops) assert.equal(stop.qty, '0.010')
  const opened = await provider.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(opened[0]!.lots, 0.01)
})

// ── Leg book ────────────────────────────────────────────────────────────────

test('when one stop fires the surviving partner is cancelled and the leg leaves the book', async () => {
  const { fake, provider } = setup()
  await provider.orderSend('acct-1', { ...BUY, stoploss: 64_000, takeprofit: 67_000 })
  // The stop loss triggered: it vanishes from the open conditional list and the position closes.
  fake.stopOrders = fake.stopOrders.filter(o => !String(o.orderLinkId).startsWith('TSL_'))
  fake.positions = []
  const opened = await provider.openedOrders('acct-1')
  assert.deepEqual(opened, [])
  assert.equal(fake.stopOrders.length, 0, 'take profit was cancelled')
})

test('leg quantities are trimmed to what the exchange position still holds', async () => {
  const { fake, provider } = setup()
  await provider.orderSend('acct-1', BUY)
  fake.positions[0]!.size = '0.010'
  const opened = await provider.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(opened[0]!.lots, 0.01)
})

test('legs and stops are rebuilt from Bybit after a worker restart', async () => {
  const { fake, provider, make } = setup()
  const placed = await provider.orderSend('acct-1', { ...BUY, stoploss: 64_000, takeprofit: 67_000 })

  const restarted = make()
  const opened = await restarted.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(opened.length, 1)
  assert.equal(opened[0]!.ticket, placed.ticket)
  assert.equal(opened[0]!.operation, 'Buy')
  assert.equal(opened[0]!.lots, 0.015)
  assert.equal(opened[0]!.stopLoss, 64_000)
  assert.equal(opened[0]!.takeProfit, 67_000)
  assert.equal(opened[0]!.comment, 'TScopier:abcdef12')

  // The rebuilt leg can be closed, which also cancels both stops.
  await restarted.orderClose('acct-1', { ticket: placed.ticket! } as never)
  assert.equal(fake.stopOrders.length, 0)
  assert.equal(fake.positions.length, 0)
})

test('history rows come from closed-pnl and keep the leg ticket of a copier close', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { ...BUY, stoploss: 64_000 })
  await provider.orderClose('acct-1', { ticket: placed.ticket! } as never)
  const from = new Date(NOW - 86_400_000).toISOString()
  const to = new Date(NOW + 1000).toISOString()
  const rows = await provider.orderHistory('acct-1', from, to) as Array<Record<string, unknown>>
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.ticket, placed.ticket)
  assert.equal(rows[0]!.operation, 'Buy')
  assert.equal(rows[0]!.profit, 12.5)
  assert.equal(rows[0]!.comment, 'TScopier:abcdef12')
  assert.ok(fake.calls.some(c => c.path === '/v5/position/closed-pnl'))
})

// ── Account ─────────────────────────────────────────────────────────────────

test('accountSummary maps the unified wallet balance', async () => {
  const { provider } = setup()
  const summary = await provider.accountSummary('acct-1')
  assert.equal(summary.balance, 1000)
  assert.equal(summary.equity, 1010)
  assert.equal(summary.profit, 10)
  assert.equal(summary.margin, 100)
  assert.equal(summary.freeMargin, 900)
  assert.equal(summary.leverage, 10)
  assert.equal(summary.currency, 'USDT')
})

test('mtStatus reports the account margin mode and never changes it', async () => {
  const { fake, provider } = setup()
  fake.marginMode = 'ISOLATED_MARGIN'
  const status = await provider.mtStatus('acct-1')
  assert.equal(status.broker?.connected, true)
  assert.equal(status.account?.tradeAllowed, true)
  assert.equal((status.account as { marginMode?: string }).marginMode, 'ISOLATED_MARGIN')
  assert.equal(fake.calls.filter(c => c.method === 'POST').length, 0)
})

test('a classic (non-Unified) account is rejected for orders and reported as not tradable', async () => {
  const { fake, provider } = setup()
  fake.unifiedStatus = 1
  assert.equal(await provider.verifyTradingReady('acct-1'), false)
  await assert.rejects(provider.orderSend('acct-1', BUY), /Unified Trading Account/)
  assert.equal(fake.find('POST', '/v5/order/create').length, 0)
})

test('an unknown symbol is rejected before any order call', async () => {
  const { fake, provider } = setup()
  await assert.rejects(provider.orderSend('acct-1', { symbol: 'NOPEUSD', operation: 'Buy', volume: 1 }), /not available on Bybit/)
  assert.equal(fake.find('POST', '/v5/order/create').length, 0)
})
