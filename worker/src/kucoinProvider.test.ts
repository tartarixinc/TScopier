import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { KucoinProvider } from './kucoinProvider'
import { CLOSE_PREFIX, childOrderLinkId, SL_PREFIX, ticketFromChildLinkId } from './kucoin/symbols'
import {
  KucoinApiError,
  KucoinClient,
  buildBody,
  signPassphrase,
  signRequest,
  type KucoinCredential,
} from './kucoin/client'

const API_KEY = 'test-api-key'
const API_SECRET = 'test-api-secret'
const PASSPHRASE = 'test-passphrase'
const NOW = 1_790_000_000_000

const contractList = [
  {
    symbol: 'XBTUSDTM',
    status: 'Open',
    baseCurrency: 'XBT',
    settleCurrency: 'USDT',
    multiplier: 0.001,
    lotSize: 1,
    tickSize: 0.1,
    maxOrderQty: 1_000_000,
    marketMaxOrderQty: 4000,
    maxLeverage: 100,
    isInverse: false,
    supportCross: true,
  },
  {
    symbol: 'ETHUSDTM',
    status: 'Open',
    baseCurrency: 'ETH',
    settleCurrency: 'USDT',
    multiplier: 0.01,
    lotSize: 1,
    tickSize: 0.01,
    maxOrderQty: 1_000_000,
    marketMaxOrderQty: 4000,
    maxLeverage: 50,
    isInverse: false,
    supportCross: true,
  },
]

type Call = {
  method: string
  path: string
  params: Record<string, string>
  body: Record<string, unknown>
  signed: boolean
  version?: string
  signatureValid: boolean
  passphraseValid: boolean
}

type Row = Record<string, unknown>
type Reply = unknown | ((call: Call, match: RegExpExecArray | null) => unknown)

function ok(data: unknown) {
  return { status: 200, payload: { code: '200000', data } }
}

function fail(code: number, msg: string, status = 400) {
  return { status, payload: { code: String(code), msg } }
}

type Resolved = { status: number; payload: unknown }

class FakeKucoin {
  calls: Call[] = []
  nextOrder = 1
  ask = 65_000
  bid = 64_990
  hedge = false
  positionModeSet = true
  marketOutcome: 'fill' | 'dead' = 'fill'
  rejectStops = false
  rejectVersions = new Set<string>()
  marginModes = new Map<string, string>()
  marginSwitchFails = false
  crossLeverageFails = false
  orders = new Map<string, Row>()
  history: Row[] = []
  stops: Row[] = []
  openLimits: Row[] = []
  positions: Row[] = []
  fills: Row[] = []
  closedPositions: Row[] = []

  private adjust(symbol: string, side: string, lots: number, price: number, reduceOnly: boolean, positionSide: string) {
    if (positionSide === 'BOTH') {
      const signed = side === 'buy' ? lots : -lots
      const existing = this.positions.find(row => row.symbol === symbol)
      if (!existing) {
        this.positions.push({ symbol, positionSide, currentQty: signed, avgEntryPrice: price, markPrice: price, isOpen: true })
        return
      }
      const next = Number(existing.currentQty) + signed
      if (next === 0) this.positions = this.positions.filter(row => row !== existing)
      else existing.currentQty = next
      return
    }
    const existing = this.positions.find(row => row.symbol === symbol && row.positionSide === positionSide)
    const dir = positionSide === 'LONG' ? 1 : -1
    if (reduceOnly) {
      if (!existing) return
      const left = Math.abs(Number(existing.currentQty)) - lots
      if (left <= 0) this.positions = this.positions.filter(row => row !== existing)
      else existing.currentQty = dir * left
      return
    }
    if (existing) existing.currentQty = Number(existing.currentQty) + dir * lots
    else this.positions.push({ symbol, positionSide, currentQty: dir * lots, avgEntryPrice: price, markPrice: price, isOpen: true })
  }

  private create(call: Call): Resolved {
    const body = call.body
    const symbol = String(body.symbol)
    const side = String(body.side)
    const size = Number(body.size)
    const positionSide = String(body.positionSide ?? 'BOTH')
    if (!this.positionModeSet) return fail(330011, 'Please set the position mode first')
    const id = `ord-${this.nextOrder++}`
    const common: Row = {
      id,
      orderId: id,
      clientOid: String(body.clientOid ?? ''),
      symbol,
      side,
      size,
      price: body.price !== undefined ? String(body.price) : '0',
      positionSide,
      marginMode: body.marginMode,
      leverage: body.leverage,
      reduceOnly: body.reduceOnly === true,
      closeOrder: false,
      createdAt: NOW,
    }
    if (body.stop !== undefined) {
      if (this.rejectStops) return fail(300003, 'Stop order rejected')
      this.stops.push({ ...common, stop: body.stop, stopPrice: String(body.stopPrice), stopTriggered: false, status: 'untriggered' })
      return ok({ orderId: id })
    }
    if (body.type === 'limit') {
      const order = { ...common, type: 'limit', filledSize: 0, avgDealPrice: '0', status: 'open', isActive: true }
      this.orders.set(id, order)
      this.openLimits.push(order)
      return ok({ orderId: id })
    }
    const price = side === 'buy' ? this.ask : this.bid
    if (this.marketOutcome === 'dead') {
      this.orders.set(id, { ...common, type: 'market', filledSize: 0, avgDealPrice: '0', status: 'done', isActive: false, remark: 'no liquidity' })
      return ok({ orderId: id })
    }
    const reduceOnly = body.reduceOnly === true
    const done = { ...common, type: 'market', filledSize: size, avgDealPrice: String(price), status: 'done', isActive: false, closeOrder: reduceOnly }
    this.orders.set(id, done)
    this.history.push(done)
    this.fills.push({
      orderId: id,
      symbol,
      side,
      size,
      price: String(price),
      fee: '0.039',
      tradeTime: NOW * 1e6,
    })
    this.adjust(symbol, side, size, price, reduceOnly, positionSide)
    return ok({ orderId: id })
  }

  private routes: Array<{ method: string; pattern: RegExp; reply: Reply }> = []

  constructor() {
    const on = (method: string, pattern: RegExp, reply: Reply) => this.routes.push({ method, pattern, reply })
    on('GET', /^\/api\/v1\/timestamp$/, ok(NOW))
    on('GET', /^\/api\/v1\/contracts\/active$/, ok(contractList))
    on('GET', /^\/api\/v1\/ticker$/, () => ok({ bestBidPrice: String(this.bid), bestAskPrice: String(this.ask) }))
    on('GET', /^\/api\/v1\/account-overview$/, ok({
      accountEquity: 1010,
      marginBalance: 1000,
      unrealisedPNL: 10,
      positionMargin: 80,
      orderMargin: 20,
      availableBalance: 900,
      currency: 'USDT',
    }))
    on('GET', /^\/api\/v2\/position\/getPositionMode$/, () => ok({ positionMode: this.hedge ? 1 : 0 }))
    on('POST', /^\/api\/v2\/position\/switchPositionMode$/, (call: Call) => {
      this.positionModeSet = true
      this.hedge = String(call.body.positionMode) === '1'
      return ok({ positionMode: Number(call.body.positionMode) })
    })
    on('GET', /^\/api\/v2\/position\/getMarginMode$/, (call: Call) => ok({
      symbol: call.params.symbol,
      marginMode: this.marginModes.get(call.params.symbol ?? '') ?? 'ISOLATED',
    }))
    on('POST', /^\/api\/v2\/position\/changeMarginMode$/, (call: Call) => {
      if (this.marginSwitchFails) return fail(300009, 'Cannot switch margin mode while a position is open')
      this.marginModes.set(String(call.body.symbol), String(call.body.marginMode))
      return ok({ symbol: call.body.symbol, marginMode: call.body.marginMode })
    })
    on('POST', /^\/api\/v2\/changeCrossUserLeverage$/, () => {
      if (this.crossLeverageFails) return fail(300010, 'Leverage not allowed')
      return ok({ leverage: '10' })
    })
    on('POST', /^\/api\/v1\/orders$/, (call: Call) => this.create(call))
    on('GET', /^\/api\/v1\/orders\/([^/]+)$/, (_call: Call, match: RegExpExecArray | null) => {
      const order = this.orders.get(decodeURIComponent(match![1]!))
      return order ? ok(order) : fail(100003, 'order not exist')
    })
    on('DELETE', /^\/api\/v1\/orders\/([^/]+)$/, (_call: Call, match: RegExpExecArray | null) => {
      const id = decodeURIComponent(match![1]!)
      const before = this.stops.length + this.openLimits.length
      this.stops = this.stops.filter(row => row.id !== id)
      this.openLimits = this.openLimits.filter(row => row.id !== id)
      if (before === this.stops.length + this.openLimits.length) return fail(100004, 'order cannot be cancelled')
      return ok({ cancelledOrderIds: [id] })
    })
    on('GET', /^\/api\/v1\/orders$/, (call: Call) => {
      if (call.params.status === 'active') return ok({ items: this.openLimits, totalPage: 1 })
      const startAt = Number(call.params.startAt ?? 0)
      const endAt = Number(call.params.endAt ?? Number.MAX_SAFE_INTEGER)
      const rows = this.history.filter(row =>
        (!call.params.symbol || row.symbol === call.params.symbol)
        && Number(row.createdAt) >= startAt
        && Number(row.createdAt) <= endAt)
      return ok({ items: rows, totalPage: 1 })
    })
    on('GET', /^\/api\/v1\/stopOrders$/, () => ok({ items: this.stops, totalPage: 1 }))
    on('GET', /^\/api\/v1\/positions$/, () => ok(this.positions))
    on('GET', /^\/api\/v1\/fills$/, (call: Call) => {
      let rows = this.fills
      if (call.params.orderId) rows = rows.filter(row => row.orderId === call.params.orderId)
      return ok({ items: rows, totalPage: 1 })
    })
    on('GET', /^\/api\/v1\/history-positions$/, () => ok({ items: this.closedPositions, totalPage: 1 }))
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
    const signed = headers['KC-API-SIGN'] !== undefined
    let signatureValid = false
    let passphraseValid = false
    if (signed) {
      const expected = createHmac('sha256', API_SECRET)
        .update(`${headers['KC-API-TIMESTAMP']}${method}${url.pathname}${url.search}${rawBody}`)
        .digest('base64')
      signatureValid = expected === headers['KC-API-SIGN']
      passphraseValid = createHmac('sha256', API_SECRET).update(PASSPHRASE).digest('base64') === headers['KC-API-PASSPHRASE']
    }
    const call: Call = {
      method,
      path: url.pathname,
      params,
      body,
      signed,
      version: headers['KC-API-KEY-VERSION'],
      signatureValid,
      passphraseValid,
    }
    this.calls.push(call)
    let resolved: Resolved
    if (signed && call.version && this.rejectVersions.has(call.version)) {
      resolved = fail(400004, 'Invalid KC-API-PASSPHRASE')
    } else {
      const route = this.routes.find(candidate => candidate.method === method && candidate.pattern.test(url.pathname))
      if (!route) {
        resolved = fail(404000, `unhandled ${method} ${url.pathname}`, 404)
      } else {
        const match = route.pattern.exec(url.pathname)
        const reply = typeof route.reply === 'function'
          ? (route.reply as (c: Call, m: RegExpExecArray | null) => unknown)(call, match)
          : route.reply
        resolved = reply as Resolved
      }
    }
    return new Response(JSON.stringify(resolved.payload), { status: resolved.status })
  }

  find(method: string, path: string): Call[] {
    return this.calls.filter(c => c.method === method && c.path === path)
  }
}

function credential(overrides: Partial<KucoinCredential> = {}): KucoinCredential {
  return {
    accountId: 'acct-1',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    passphrase: PASSPHRASE,
    marginUsdt: 100,
    leverage: 10,
    marginMode: 'isolated',
    ...overrides,
  }
}

function setup(overrides: Partial<KucoinCredential> = {}) {
  const fake = new FakeKucoin()
  const make = () => new KucoinProvider({
    loadCredentials: async () => credential(overrides),
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    sleep: async () => {},
  })
  return { fake, provider: make(), make }
}

const BUY = { symbol: 'BTCUSDT', operation: 'Buy', volume: 5, comment: 'TScopier:chan:abcdef12' } as const
const SELL = { symbol: 'BTCUSDT', operation: 'Sell', volume: 5, comment: 'TScopier:chan:abcdef12' } as const

// ── Signing and transport ───────────────────────────────────────────────────

test('signRequest and signPassphrase are base64 HMAC-SHA256', () => {
  const timestamp = '1690000000000'
  const body = buildBody({ symbol: 'XBTUSDTM', size: 1, skip: undefined, empty: '' })
  assert.equal(body, '{"symbol":"XBTUSDTM","size":1}')
  assert.equal(
    signRequest('secret', timestamp, 'post', '/api/v1/orders', body),
    createHmac('sha256', 'secret').update(`${timestamp}POST/api/v1/orders${body}`).digest('base64'),
  )
  assert.equal(
    signRequest('secret', timestamp, 'GET', '/api/v1/orders?status=active', ''),
    createHmac('sha256', 'secret').update(`${timestamp}GET/api/v1/orders?status=active`).digest('base64'),
  )
  assert.equal(signPassphrase('secret', 'phrase'), createHmac('sha256', 'secret').update('phrase').digest('base64'))
})

test('signed GET, POST and DELETE requests carry the key headers; public ones do not', async () => {
  const { fake, provider } = setup()
  await provider.accountSummary('acct-1')
  const result = await provider.orderSend('acct-1', { ...BUY, stoploss: 60_000 })
  await provider.orderClose('acct-1', { ticket: result.ticket as number })
  const signed = fake.calls.filter(c => c.signed)
  assert.ok(signed.some(c => c.method === 'GET'))
  assert.ok(signed.some(c => c.method === 'POST'))
  assert.ok(signed.some(c => c.method === 'DELETE'))
  for (const call of signed) {
    assert.equal(call.signatureValid, true, `${call.method} ${call.path} signature`)
    assert.equal(call.passphraseValid, true, `${call.method} ${call.path} passphrase`)
    assert.equal(call.version, '3')
  }
  assert.ok(fake.calls.filter(c => !c.signed).every(c => c.version === undefined))
  assert.ok(fake.calls.some(c => !c.signed && c.path === '/api/v1/contracts/active'))
})

test('a key version 3 passphrase rejection falls back to version 2 and stays there', async () => {
  const { fake, provider } = setup()
  fake.rejectVersions.add('3')
  await provider.accountSummary('acct-1')
  await provider.accountSummary('acct-1')
  const versions = fake.calls.filter(c => c.signed).map(c => c.version)
  assert.deepEqual(versions, ['3', '2', '2'])
})

test('a bad passphrase on both key versions is reported with a clear message', async () => {
  const { fake, provider } = setup()
  fake.rejectVersions.add('3')
  fake.rejectVersions.add('2')
  await assert.rejects(() => provider.accountSummary('acct-1'), /passphrase/i)
})

test('a 400002 timestamp error resyncs with server time and retries once', async () => {
  const headersSeen: string[] = []
  let timestampCalls = 0
  let signedCalls = 0
  const fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname === '/api/v1/timestamp') {
      timestampCalls += 1
      return new Response(JSON.stringify({ code: '200000', data: timestampCalls === 1 ? NOW : NOW + 7000 }))
    }
    signedCalls += 1
    if (signedCalls === 1) return new Response(JSON.stringify({ code: '400002', msg: 'Invalid KC-API-TIMESTAMP' }), { status: 400 })
    return new Response(JSON.stringify({ code: '200000', data: { ok: true } }))
  }
  const wrapped: typeof fetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers['KC-API-TIMESTAMP']) headersSeen.push(headers['KC-API-TIMESTAMP'])
    return fetchImpl(input, init)
  }
  const client = new KucoinClient({ apiKey: 'k', apiSecret: 's', passphrase: 'p' }, { fetchImpl: wrapped, now: () => NOW })
  const data = await client.signed('GET', '/api/v1/positions')
  assert.deepEqual(data, { ok: true })
  assert.deepEqual(headersSeen, [String(NOW), String(NOW + 7000)])
})

test('an HTTP 403 and region code 40010 explain the block', async () => {
  const blocked = new KucoinClient({ apiKey: 'k', apiSecret: 's', passphrase: 'p' }, {
    fetchImpl: async () => new Response('forbidden', { status: 403 }),
  })
  await assert.rejects(() => blocked.publicGet('/api/v1/ticker'), (error: unknown) => {
    assert.ok(error instanceof KucoinApiError)
    assert.match((error as Error).message, /403/)
    return true
  })
  const region = new KucoinClient({ apiKey: 'k', apiSecret: 's', passphrase: 'p' }, {
    fetchImpl: async () => new Response(JSON.stringify({ code: '40010', msg: 'restricted' }), { status: 400 }),
  })
  await assert.rejects(() => region.publicGet('/api/v1/ticker'), /region/i)
})

// ── Entry orders ────────────────────────────────────────────────────────────

test('a market buy sizes from margin x leverage in lots, then places reduce-only stop orders', async () => {
  const { fake, provider } = setup()
  const result = await provider.orderSend('acct-1', { ...BUY, stoploss: 60_000, takeprofit: 70_000 })
  const [entry] = fake.find('POST', '/api/v1/orders').map(c => c.body)
  assert.equal(entry!.symbol, 'XBTUSDTM')
  assert.equal(entry!.side, 'buy')
  assert.equal(entry!.type, 'market')
  assert.equal(entry!.size, 15)
  assert.equal(entry!.marginMode, 'ISOLATED')
  assert.equal(entry!.leverage, 10)
  assert.equal(entry!.positionSide, undefined)
  assert.match(String(entry!.clientOid), /^TScopier_/)

  const stops = fake.find('POST', '/api/v1/orders').map(c => c.body).filter(body => body.stop !== undefined)
  assert.equal(stops.length, 2)
  const sl = stops.find(body => String(body.clientOid).startsWith('TSL_'))!
  const tp = stops.find(body => String(body.clientOid).startsWith('TST_'))!
  assert.equal(sl.stop, 'down')
  assert.equal(tp.stop, 'up')
  assert.equal(sl.stopPriceType, 'MP')
  assert.equal(sl.stopPrice, '60000.0')
  assert.equal(tp.stopPrice, '70000.0')
  assert.equal(sl.reduceOnly, true)
  assert.equal(sl.side, 'sell')
  assert.equal(sl.size, 15)
  assert.equal(ticketFromChildLinkId(sl.clientOid, SL_PREFIX), result.ticket)

  assert.equal(result.lots, 0.015)
  assert.equal(result.openPrice, 65_000)
  assert.equal(result.stopLoss, 60_000)
  assert.equal(result.takeProfit, 70_000)
  assert.equal(result.symbol, 'XBTUSDTM')
})

test('a market sell flips the stop trigger directions', async () => {
  const { fake, provider } = setup()
  await provider.orderSend('acct-1', { ...SELL, stoploss: 70_000, takeprofit: 60_000 })
  const stops = fake.find('POST', '/api/v1/orders').map(c => c.body).filter(body => body.stop !== undefined)
  assert.equal(stops.find(body => String(body.clientOid).startsWith('TSL_'))!.stop, 'up')
  assert.equal(stops.find(body => String(body.clientOid).startsWith('TST_'))!.stop, 'down')
  assert.ok(stops.every(body => body.side === 'buy'))
})

test('the signal volume is ignored and the lot count comes from margin and leverage', async () => {
  const { fake, provider } = setup({ marginUsdt: 200, leverage: 5 })
  await provider.orderSend('acct-1', { ...BUY, volume: 99 })
  // 200 x 5 = 1000 USDT / 65000 / 0.001 = 15 lots
  assert.equal(fake.find('POST', '/api/v1/orders')[0]!.body.size, 15)
})

test('XAU-style and slash names resolve through the contract list', async () => {
  const { fake, provider } = setup()
  const quote = await provider.quote('acct-1', 'ETH/USDT')
  assert.equal(quote.symbol, 'ETHUSDTM')
  assert.equal(quote.bid, 64_990)
  assert.equal(quote.ask, 65_000)
  assert.equal(fake.find('GET', '/api/v1/ticker')[0]!.params.symbol, 'ETHUSDTM')
})

test('leverage above the contract maximum is rejected before any order call', async () => {
  const { fake, provider } = setup({ leverage: 200 })
  await assert.rejects(() => provider.orderSend('acct-1', BUY), /above the KuCoin maximum of 100x/)
  assert.equal(fake.find('POST', '/api/v1/orders').length, 0)
})

test('a margin below one lot is rejected with a clear message', async () => {
  const { fake, provider } = setup({ marginUsdt: 1, leverage: 1 })
  await assert.rejects(() => provider.orderSend('acct-1', BUY), /below one XBTUSDTM lot/)
  assert.equal(fake.find('POST', '/api/v1/orders').length, 0)
})

test('a market order is capped at the contract market maximum', async () => {
  const { fake, provider } = setup({ marginUsdt: 1_000_000, leverage: 100 })
  await provider.orderSend('acct-1', BUY)
  assert.equal(fake.find('POST', '/api/v1/orders')[0]!.body.size, 4000)
})

test('an unknown symbol is rejected before any order call', async () => {
  const { fake, provider } = setup()
  await assert.rejects(() => provider.orderSend('acct-1', { ...BUY, symbol: 'NOPEUSDT' }), /not available on KuCoin/)
  assert.equal(fake.find('POST', '/api/v1/orders').length, 0)
})

test('a market order KuCoin ends with nothing filled is reported, not recorded', async () => {
  const { fake, provider } = setup()
  fake.marketOutcome = 'dead'
  await assert.rejects(() => provider.orderSend('acct-1', BUY), /did not fill/)
  assert.deepEqual(await provider.openedOrders('acct-1'), [])
})

// ── Margin mode, leverage, position mode ────────────────────────────────────

test('isolated mode is checked once per symbol and carries leverage on the order', async () => {
  const { fake, provider } = setup()
  await provider.orderSend('acct-1', BUY)
  await provider.orderSend('acct-1', BUY)
  assert.equal(fake.find('GET', '/api/v2/position/getMarginMode').length, 1)
  assert.equal(fake.find('POST', '/api/v2/position/changeMarginMode').length, 0)
  assert.equal(fake.find('POST', '/api/v2/changeCrossUserLeverage').length, 0)
})

test('cross mode switches the symbol, sets cross leverage once and omits order leverage', async () => {
  const { fake, provider } = setup({ marginMode: 'cross' })
  await provider.orderSend('acct-1', BUY)
  await provider.orderSend('acct-1', BUY)
  const switches = fake.find('POST', '/api/v2/position/changeMarginMode')
  assert.equal(switches.length, 1)
  assert.deepEqual(switches[0]!.body, { symbol: 'XBTUSDTM', marginMode: 'CROSS' })
  const leverage = fake.find('POST', '/api/v2/changeCrossUserLeverage')
  assert.equal(leverage.length, 1)
  assert.deepEqual(leverage[0]!.body, { symbol: 'XBTUSDTM', leverage: '10' })
  const entries = fake.find('POST', '/api/v1/orders').map(c => c.body)
  assert.ok(entries.every(body => body.marginMode === 'CROSS' && body.leverage === undefined))
})

test('a refused margin mode switch rejects the order before it is placed', async () => {
  const { fake, provider } = setup({ marginMode: 'cross' })
  fake.marginSwitchFails = true
  await assert.rejects(() => provider.orderSend('acct-1', BUY), /would not switch XBTUSDTM to cross margin/)
  assert.equal(fake.find('POST', '/api/v1/orders').length, 0)
})

test('a rejected cross leverage rejects the order before it is placed', async () => {
  const { fake, provider } = setup({ marginMode: 'cross' })
  fake.crossLeverageFails = true
  await assert.rejects(() => provider.orderSend('acct-1', BUY), /rejected 10x cross leverage/)
  assert.equal(fake.find('POST', '/api/v1/orders').length, 0)
})

test('hedge mode sends positionSide LONG for buys and SHORT for sells, including on the stops', async () => {
  const { fake, provider } = setup()
  fake.hedge = true
  await provider.orderSend('acct-1', { ...BUY, stoploss: 60_000 })
  await provider.orderSend('acct-1', { ...SELL, stoploss: 70_000 })
  const bodies = fake.find('POST', '/api/v1/orders').map(c => c.body)
  const buyBodies = bodies.filter(body => body.side === 'buy' && body.stop === undefined)
  const sellStops = bodies.filter(body => body.side === 'buy' && body.stop !== undefined)
  assert.equal(buyBodies[0]!.positionSide, 'LONG')
  assert.equal(bodies.find(body => body.side === 'sell' && body.stop === undefined && body.reduceOnly === undefined)!.positionSide, 'SHORT')
  assert.equal(sellStops[0]!.positionSide, 'SHORT')
})

test('a fresh account with no position mode is switched to one-way once and the order retried', async () => {
  const { fake, provider } = setup()
  fake.positionModeSet = false
  fake.hedge = true
  const result = await provider.orderSend('acct-1', BUY)
  const switches = fake.find('POST', '/api/v2/position/switchPositionMode')
  assert.equal(switches.length, 1)
  assert.deepEqual(switches[0]!.body, { positionMode: '0' })
  const posts = fake.find('POST', '/api/v1/orders').map(c => c.body)
  assert.equal(posts.length, 2)
  assert.equal(posts[1]!.positionSide, undefined)
  assert.equal(result.lots, 0.015)
})

test('when the stop loss is rejected the position is closed straight away', async () => {
  const { fake, provider } = setup()
  fake.rejectStops = true
  await assert.rejects(
    () => provider.orderSend('acct-1', { ...BUY, stoploss: 60_000 }),
    /rejected the stop loss for XBTUSDTM, so the position was closed/,
  )
  assert.equal(fake.positions.length, 0)
  const close = fake.find('POST', '/api/v1/orders').map(c => c.body).find(body => String(body.clientOid).startsWith(`${CLOSE_PREFIX}_`))
  assert.ok(close)
  assert.equal(close!.reduceOnly, true)
  assert.deepEqual(await provider.openedOrders('acct-1'), [])
})

// ── Limit orders ────────────────────────────────────────────────────────────

test('a limit order stays pending, cannot change price, and is cancelled on close', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { symbol: 'BTCUSDT', operation: 'BuyLimit', price: 60_000, volume: 5, comment: 'TScopier:chan:abcdef12' })
  const body = fake.find('POST', '/api/v1/orders')[0]!.body
  assert.equal(body.type, 'limit')
  assert.equal(body.price, '60000.0')
  assert.equal(body.timeInForce, 'GTC')
  assert.equal(body.size, 16)
  assert.equal(placed.state, 'Placed')

  const open = await provider.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(open.length, 1)
  assert.equal(open[0]!.operation, 'BuyLimit')
  assert.equal(open[0]!.positionTicket, undefined)

  await assert.rejects(
    () => provider.orderModify('acct-1', { ticket: placed.ticket as number, price: 59_000 }),
    /cannot change the price of a pending order/,
  )
  await provider.orderModify('acct-1', { ticket: placed.ticket as number, price: 60_000 })

  const closed = await provider.orderClose('acct-1', { ticket: placed.ticket as number })
  assert.equal(closed.state, 'position_closed')
  assert.equal(fake.openLimits.length, 0)
  assert.deepEqual(await provider.openedOrders('acct-1'), [])
})

// ── Modify and close ────────────────────────────────────────────────────────

test('modifying stops cancels the old order and places the new trigger; 0 removes it', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { ...BUY, stoploss: 60_000, takeprofit: 70_000 })
  const ticket = placed.ticket as number
  const modified = await provider.orderModify('acct-1', { ticket, stoploss: 61_000 })
  assert.equal(modified.stopLoss, 61_000)
  assert.equal(modified.takeProfit, 70_000)
  const slOrders = fake.stops.filter(row => String(row.clientOid).startsWith('TSL_'))
  assert.equal(slOrders.length, 1)
  assert.equal(slOrders[0]!.stopPrice, '61000.0')
  assert.equal(fake.stops.length, 2)

  const removed = await provider.orderModify('acct-1', { ticket, takeprofit: 0 })
  assert.equal(removed.takeProfit, undefined)
  assert.equal(fake.stops.length, 1)
})

test('a full close sends a reduce-only market order, cancels the stops and returns realized profit', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { ...BUY, stoploss: 60_000, takeprofit: 70_000 })
  const closed = await provider.orderClose('acct-1', { ticket: placed.ticket as number })
  const close = fake.find('POST', '/api/v1/orders').map(c => c.body).find(body => String(body.clientOid).startsWith('TSX_'))!
  assert.equal(close.reduceOnly, true)
  assert.equal(close.side, 'sell')
  assert.equal(close.size, 15)
  assert.equal(fake.stops.length, 0)
  assert.equal(fake.positions.length, 0)
  assert.equal(closed.closePrice, 64_990)
  assert.equal(closed.lots, 0.015)
  // (64990 - 65000) x 15 lots x 0.001
  assert.equal(closed.profit, -0.15)
  assert.equal(closed.commission, -0.039)
  assert.equal(closed.state, 'position_closed')
  assert.deepEqual(await provider.openedOrders('acct-1'), [])
})

test('a partial close trims the leg and rebuilds the stops at the smaller size', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', { ...BUY, stoploss: 60_000, takeprofit: 70_000 })
  const ticket = placed.ticket as number
  const closed = await provider.orderClose('acct-1', { ticket, lots: 0.005 })
  const close = fake.find('POST', '/api/v1/orders').map(c => c.body).find(body => String(body.clientOid).startsWith('TSX_'))!
  assert.equal(close.size, 5)
  assert.equal(closed.lots, 0.005)
  assert.equal(fake.stops.length, 2)
  assert.ok(fake.stops.every(row => row.size === 10))
  const open = await provider.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(open.length, 1)
  assert.equal(open[0]!.lots, 0.01)
  assert.equal(open[0]!.stopLoss, 60_000)
  assert.equal(open[0]!.takeProfit, 70_000)
})

test('when one stop fires the surviving partner is cancelled and the leg leaves the book', async () => {
  const { fake, provider } = setup()
  await provider.orderSend('acct-1', { ...BUY, stoploss: 60_000, takeprofit: 70_000 })
  assert.equal((await provider.openedOrders('acct-1')).length, 1)
  // The stop loss triggers: KuCoin removes it and the position closes.
  fake.stops = fake.stops.filter(row => !String(row.clientOid).startsWith('TSL_'))
  fake.positions = []
  assert.deepEqual(await provider.openedOrders('acct-1'), [])
  assert.equal(fake.stops.length, 0)
})

test('leg quantities are trimmed to what the exchange position still holds', async () => {
  const { fake, provider } = setup()
  await provider.orderSend('acct-1', BUY)
  fake.positions[0]!.currentQty = 10
  const open = await provider.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(open[0]!.lots, 0.01)
})

test('legs and stops are rebuilt from KuCoin after a worker restart', async () => {
  const { fake, provider, make } = setup()
  const placed = await provider.orderSend('acct-1', { ...BUY, stoploss: 60_000, takeprofit: 70_000 })
  const fresh = make()
  const open = await fresh.openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(open.length, 1)
  assert.equal(open[0]!.ticket, placed.ticket)
  assert.equal(open[0]!.operation, 'Buy')
  assert.equal(open[0]!.lots, 0.015)
  assert.equal(open[0]!.openPrice, 65_000)
  assert.equal(open[0]!.stopLoss, 60_000)
  assert.equal(open[0]!.takeProfit, 70_000)
  assert.equal(open[0]!.comment, placed.comment)

  // The rebuilt leg can be closed and its stops go with it.
  await fresh.orderClose('acct-1', { ticket: placed.ticket as number })
  assert.equal(fake.stops.length, 0)
  assert.equal(fake.positions.length, 0)
})

test('a pending limit order is rebuilt after a restart', async () => {
  const { provider, make } = setup()
  const placed = await provider.orderSend('acct-1', { symbol: 'BTCUSDT', operation: 'SellLimit', price: 70_000, volume: 5, comment: 'TScopier:chan:abcdef12' })
  const open = await make().openedOrders('acct-1') as Array<Record<string, unknown>>
  assert.equal(open.length, 1)
  assert.equal(open[0]!.ticket, placed.ticket)
  assert.equal(open[0]!.operation, 'SellLimit')
})

// ── History ─────────────────────────────────────────────────────────────────

test('history rows come from history-positions and keep the leg ticket of a copier close', async () => {
  const { fake, provider } = setup()
  const placed = await provider.orderSend('acct-1', BUY)
  await provider.orderClose('acct-1', { ticket: placed.ticket as number })
  fake.closedPositions.push({
    closeId: 'cp-1',
    symbol: 'XBTUSDTM',
    type: 'CLOSE_LONG',
    openPrice: '65000',
    closePrice: '64990',
    pnl: '-0.15',
    tradeFee: '0.078',
    fundingFee: '0',
    openTime: NOW - 1000,
    closeTime: NOW,
  })
  const rows = await provider.orderHistory(
    'acct-1',
    new Date(NOW - 86_400_000).toISOString(),
    new Date(NOW).toISOString(),
  ) as Array<Record<string, unknown>>
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.ticket, placed.ticket)
  assert.equal(rows[0]!.symbol, 'XBTUSDTM')
  assert.equal(rows[0]!.operation, 'Buy')
  assert.equal(rows[0]!.lots, 0.015)
  assert.equal(rows[0]!.profit, -0.15)
  assert.equal(rows[0]!.commission, -0.078)
  assert.equal(rows[0]!.openPrice, 65_000)
  assert.equal(rows[0]!.closePrice, 64_990)
  assert.equal(rows[0]!.comment, placed.comment)
  assert.equal(rows[0]!.time, NOW)
})

test('history is empty when nothing closed', async () => {
  const { provider } = setup()
  assert.deepEqual(
    await provider.orderHistory('acct-1', new Date(NOW - 86_400_000).toISOString(), new Date(NOW).toISOString()),
    [],
  )
})

// ── Account ─────────────────────────────────────────────────────────────────

test('accountSummary maps the futures account overview', async () => {
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

test('mtStatus reports a connected, trade-ready account with the configured margin mode', async () => {
  const { provider } = setup({ marginMode: 'cross' })
  const status = await provider.mtStatus('acct-1')
  assert.equal(status.status, 'ready')
  assert.equal(status.broker?.connected, true)
  assert.equal(status.account?.tradeAllowed, true)
  assert.equal((status.account as Record<string, unknown>).marginMode, 'cross')
  assert.equal(await provider.verifyTradingReady('acct-1'), true)
})

test('symbolParams expresses lot rules in base units', async () => {
  const { provider } = setup()
  const params = await provider.symbolParams('acct-1', 'BTCUSDT')
  assert.equal(params.symbolName, 'XBTUSDTM')
  assert.equal(params.groupParams?.minLot, 0.001)
  assert.equal(params.groupParams?.lotStep, 0.001)
  assert.equal(params.groupParams?.maxLot, 4)
})

test('missing credentials are reported as not configured', async () => {
  const provider = new KucoinProvider({ loadCredentials: async () => null, fetchImpl: new FakeKucoin().fetchImpl, now: () => NOW })
  await assert.rejects(() => provider.accountSummary('acct-1'), /not configured/)
})

test('child link ids built for stops round-trip through the helper', () => {
  const ticket = 450_000_000_005
  assert.equal(ticketFromChildLinkId(childOrderLinkId(SL_PREFIX, ticket, 'ab12'), SL_PREFIX), ticket)
})
