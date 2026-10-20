import { strict as assert } from 'node:assert'
import { beforeEach, test } from 'node:test'
import { DxtradeProvider, type DxtradeCredential } from './dxtradeProvider'
import { resetDxtradeLoginGateForTests } from './dxtrade/client'

const NOW = 1_790_000_000_000
const SERVER = 'https://trade.broker.com/dxsca-web'
const ACCOUNT = 'default:1001'
const ACCOUNT_PATH = `/accounts/${ACCOUNT}`

type Json = Record<string, any>
type Call = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: Json | null }
type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

const instruments = [
  { symbol: 'EUR/USD', lotSize: 100_000, quantityIncrement: 1_000, priceIncrement: 0.00001, pipSize: 0.0001, type: 'FOREX' },
  { symbol: 'XAU/USD', lotSize: 100, quantityIncrement: 1, priceIncrement: 0.01, pipSize: 0.1, type: 'METAL' },
]

function json(status: number, body?: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers }
}

function apiError(status: number, errorCode: number, description: string): Reply {
  return json(status, { errorCode, description })
}

class FakeDxtrade {
  calls: Call[] = []
  logins = 0
  nextId = 5000
  etag = 'etag-1'
  positions: Json[] = []
  working: Json[] = []
  history: Json[] = []
  accountStatus = 'FULL_TRADING'
  isPositionBased = true
  /** Next request to a path matching this key answers with the given replies, in order. */
  queued = new Map<string, Reply[]>()
  /** The next authenticated request answers 401 once. */
  expireToken = false
  /** Reject order groups with a 400. */
  rejectGroups = false
  /** Reject orders with this client code prefix. */
  rejectOrderStatus: string | null = null
  /** Staleness: the first PUT/DELETE with this many remaining answers 412. */
  staleEtags = 0
  /** Place the order, then drop the response (timeout). */
  loseResponses = 0

  private token = 'tok-0'

  fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = String(init?.method ?? 'GET')
    const headers = { ...(init?.headers as Record<string, string> | undefined) }
    const body = init?.body ? JSON.parse(String(init.body)) as Json : null
    const path = decodeURIComponent(url.pathname.replace('/dxsca-web', ''))
    this.calls.push({ method, path, query: url.searchParams, headers, body })
    const reply = this.route(method, path, url.searchParams, headers, body)
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers,
    })
  }) as typeof fetch

  callsTo(method: string, path: string): Call[] {
    return this.calls.filter(call => call.method === method && call.path === path)
  }

  private route(method: string, path: string, query: URLSearchParams, headers: Record<string, string>, body: Json | null): Reply {
    const queuedKey = `${method} ${path}`
    const queue = this.queued.get(queuedKey)
    if (queue?.length) return queue.shift()!

    if (method === 'POST' && path === '/login') {
      this.logins += 1
      this.token = `tok-${this.logins}`
      this.expireToken = false
      return json(200, { sessionToken: this.token, timeout: '2026-12-31T00:00:00Z' })
    }
    if (headers.Authorization !== `DXAPI ${this.token}`) return apiError(401, 3, 'Session expired')
    if (this.expireToken) {
      this.expireToken = false
      return apiError(401, 3, 'Session expired')
    }
    if (method === 'POST' && path === '/ping') return json(200, {})
    if (method === 'POST' && path === '/logout') return json(200, {})

    if (method === 'GET' && path.startsWith('/users/')) {
      return json(200, {
        accounts: [
          { account: ACCOUNT, baseCurrency: 'USD', accountStatus: this.accountStatus, isPositionBased: this.isPositionBased },
        ],
      })
    }
    if (method === 'GET' && path === '/instruments/query') return json(200, { instruments })
    if (method === 'POST' && path === '/marketdata') {
      return json(200, { events: [{ type: 'Quote', symbol: body?.symbols?.[0], bid: 1.1, ask: 1.1002 }] })
    }
    if (method === 'GET' && path === `${ACCOUNT_PATH}/metrics`) {
      return json(200, { metrics: [{ balance: 1000, equity: 1010, openPl: 10, margin: 20, marginFree: 990, credit: 0 }] })
    }
    if (method === 'GET' && path === `${ACCOUNT_PATH}/positions`) return json(200, { positions: this.positions })
    if (method === 'GET' && path === `${ACCOUNT_PATH}/orders`) return json(200, { orders: this.working }, { ETag: this.etag })
    if (method === 'GET' && path === `${ACCOUNT_PATH}/orders/history`) return json(200, { orders: this.historyFor(query) })
    if (method === 'POST' && path === `${ACCOUNT_PATH}/orders`) return this.place(body!)
    if (method === 'PUT' && path === `${ACCOUNT_PATH}/orders`) return this.modify(headers, body!)
    if (method === 'DELETE' && path.startsWith(`${ACCOUNT_PATH}/orders/`)) {
      return this.cancel(headers, path.slice(`${ACCOUNT_PATH}/orders/`.length))
    }
    return apiError(404, 1, `no route ${method} ${path}`)
  }

  private historyFor(query: URLSearchParams): Json[] {
    const orderId = query.get('with-order-id')
    const clientId = query.get('with-client-id')
    let list = this.history
    if (orderId) list = list.filter(order => String(order.orderId) === orderId)
    if (clientId) list = list.filter(order => order.clientOrderId === clientId)
    if (query.get('in-status')) list = list.filter(order => order.status === query.get('in-status'))
    return list
  }

  private staleCheck(headers: Record<string, string>): Reply | null {
    if (this.staleEtags > 0) {
      this.staleEtags -= 1
      this.etag = `etag-${Number(this.etag.split('-')[1]) + 1}`
      return apiError(412, 7, 'Precondition failed')
    }
    if (headers['If-Match'] !== this.etag) return apiError(412, 7, 'Precondition failed')
    return null
  }

  private duplicate(code: string): boolean {
    return this.history.some(order => order.clientOrderId === code) || this.working.some(order => order.clientOrderId === code)
  }

  private place(body: Json): Reply {
    if (Array.isArray(body.orders)) {
      if (this.rejectGroups) return apiError(400, 101, 'Order groups are not supported')
      const [entry, ...children] = body.orders as Json[]
      if (this.duplicate(entry!.orderCode)) return apiError(409, 100, 'Duplicate client order id')
      const reply = this.placeOne(entry!, children)
      return reply
    }
    if (this.duplicate(body.orderCode)) return apiError(409, 100, 'Duplicate client order id')
    if (this.loseResponses > 0) {
      this.loseResponses -= 1
      this.placeOne(body, [])
      return apiError(504, 0, 'Gateway timeout')
    }
    return this.placeOne(body, [])
  }

  private record(order: Json, extra: Json): Json {
    const row: Json = {
      orderId: this.nextId,
      orderCode: String(this.nextId),
      clientOrderId: order.orderCode,
      type: order.type,
      instrument: order.instrument,
      side: order.side,
      tif: order.tif,
      metadata: order.metadata,
      issueTime: new Date(NOW).toISOString(),
      transactionTime: new Date(NOW).toISOString(),
      legs: [{
        instrument: order.instrument,
        positionEffect: order.positionEffect,
        positionCode: order.positionCode,
        quantity: order.quantity == null ? undefined : Number(order.quantity),
        price: Number(order.limitPrice ?? order.stopPrice ?? 0) || undefined,
      }],
      ...extra,
    }
    this.nextId += 1
    return row
  }

  private placeOne(order: Json, children: Json[]): Reply {
    const instrument = instruments.find(item => item.symbol === order.instrument)
    if (!instrument) return apiError(400, 101, 'Unknown instrument')
    if (this.rejectOrderStatus) {
      const row = this.record(order, {
        status: this.rejectOrderStatus,
        finalStatus: true,
        executions: [{ status: 'REJECTED', rejectReason: 'Not enough margin' }],
      })
      this.history.push(row)
      return json(200, { orderId: row.orderId, orderCode: row.orderCode })
    }

    const closing = order.positionEffect === 'CLOSE'
    if (order.type === 'MARKET') {
      const price = order.side === 'BUY' ? 1.1002 : 1.1
      if (closing) {
        const position = this.positions.find(item => item.positionCode === order.positionCode)
        if (!position) return apiError(400, 101, 'Unknown position')
        const quantity = order.quantity == null ? position.quantity : Number(order.quantity)
        position.quantity -= quantity
        if (position.quantity <= 0) {
          this.positions = this.positions.filter(item => item !== position)
          this.working = this.working.filter(item => item.legs[0].positionCode !== order.positionCode)
        }
        const row = this.record(order, {
          status: 'COMPLETED',
          finalStatus: true,
          cashTransactions: [
            { type: 'SETTLEMENT', value: 12.5 },
            { type: 'COMMISSION', value: -0.7 },
            { type: 'FINANCING', value: -0.1 },
          ],
        })
        row.legs[0].filledQuantity = quantity
        row.legs[0].averagePrice = price
        this.history.push(row)
        return json(200, { orderId: row.orderId, orderCode: row.orderCode })
      }
      const row = this.record(order, { status: 'COMPLETED', finalStatus: true })
      row.legs[0].filledQuantity = Number(order.quantity)
      row.legs[0].averagePrice = price
      this.history.push(row)
      const positionCode = String(row.orderId)
      const position: Json = {
        positionCode,
        symbol: order.instrument,
        quantity: Number(order.quantity),
        side: order.side,
        openTime: new Date(NOW).toISOString(),
        openPrice: price,
      }
      for (const child of children) {
        const price = Number(child.limitPrice ?? child.stopPrice)
        if (child.type === 'STOP') position.stopLossPrice = price
        else position.takeProfitPrice = price
        this.working.push(this.record({ ...child, positionCode }, { status: 'WORKING', finalStatus: false }))
      }
      this.positions.push(position)
      return json(200, { orderResponses: [{ orderId: row.orderId, orderCode: row.orderCode }, ...children.map((_, i) => ({ orderId: row.orderId + 1 + i }))] })
    }

    // Pending entry or position protection.
    const row = this.record(order, { status: 'WORKING', finalStatus: false })
    const parentLinks: Json[] = []
    this.working.push(row)
    for (const child of children) {
      const childRow = this.record({ ...child }, {
        status: 'WORKING',
        finalStatus: false,
        links: [{ linkType: 'CHILD', linkedClientOrderId: order.orderCode }],
      })
      parentLinks.push({ linkType: 'PARENT', linkedClientOrderId: child.orderCode })
      this.working.push(childRow)
    }
    row.links = parentLinks
    if (closing) {
      const position = this.positions.find(item => item.positionCode === order.positionCode)
      const price = Number(order.limitPrice ?? order.stopPrice)
      if (position) {
        if (order.type === 'STOP') position.stopLossPrice = price
        else position.takeProfitPrice = price
      }
    }
    if (!closing && order.type !== 'MARKET') this.history.push({ ...row, status: 'WORKING' })
    this.etag = `etag-${Number(this.etag.split('-')[1]) + 1}`
    return json(200, { orderId: row.orderId, orderCode: row.orderCode })
  }

  private modify(headers: Record<string, string>, body: Json): Reply {
    const stale = this.staleCheck(headers)
    if (stale) return stale
    const order = this.working.find(item => item.clientOrderId === body.orderCode || item.orderCode === body.orderCode)
    if (!order) return apiError(404, 1, 'Unknown order')
    const price = Number(body.limitPrice ?? body.stopPrice)
    order.legs[0].price = price
    const position = this.positions.find(item => item.positionCode === order.legs[0].positionCode)
    if (position && order.legs[0].positionEffect === 'CLOSE') {
      if (order.type === 'STOP') position.stopLossPrice = price
      else position.takeProfitPrice = price
    }
    this.etag = `etag-${Number(this.etag.split('-')[1]) + 1}`
    return json(200, {})
  }

  private cancel(headers: Record<string, string>, code: string): Reply {
    const stale = this.staleCheck(headers)
    if (stale) return stale
    const order = this.working.find(item => item.clientOrderId === code || item.orderCode === code)
    if (!order) return apiError(404, 1, 'Unknown order')
    this.working = this.working.filter(item => item !== order)
    const position = this.positions.find(item => item.positionCode === order.legs[0].positionCode)
    if (position && order.legs[0].positionEffect === 'CLOSE') {
      if (order.type === 'STOP') delete position.stopLossPrice
      else delete position.takeProfitPrice
    }
    this.etag = `etag-${Number(this.etag.split('-')[1]) + 1}`
    return json(200, {})
  }
}

function credential(overrides: Partial<DxtradeCredential> = {}): DxtradeCredential {
  return {
    accountId: 'acct-1',
    serverUrl: SERVER,
    username: 'trader',
    domain: 'default',
    password: 'secret',
    accountCode: ACCOUNT,
    isPositionBased: true,
    ...overrides,
  }
}

function makeProvider(fake: FakeDxtrade, overrides: Partial<DxtradeCredential> = {}) {
  return new DxtradeProvider({
    loadCredentials: async () => credential(overrides),
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    sleep: async () => {},
    clientOptions: { skipHostCheck: true },
  })
}

const COMMENT = 'TScopier:gold-room:abcdef12-3456:1'

beforeEach(() => {
  resetDxtradeLoginGateForTests()
})

test('logs in once, sends the DXAPI token and a User-Agent, and re-logs in after a 401', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const summary = await provider.accountSummary('acct-1')
  assert.equal(summary.balance, 1000)
  assert.equal(summary.equity, 1010)
  assert.equal(summary.currency, 'USD')
  assert.equal(fake.logins, 1)
  const authed = fake.calls.find(call => call.path === `${ACCOUNT_PATH}/metrics`)!
  assert.equal(authed.headers.Authorization, 'DXAPI tok-1')
  assert.ok(authed.headers['User-Agent'])
  const login = fake.callsTo('POST', '/login')[0]!
  assert.deepEqual(login.body, { username: 'trader', domain: 'default', password: 'secret' })

  fake.expireToken = true
  const positions = await provider.openedOrders('acct-1')
  assert.deepEqual(positions, [])
  assert.equal(fake.logins, 2)
})

test('opens a market order with SL and TP as one IF-THEN group', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const result = await provider.orderSend('acct-1', {
    symbol: 'EURUSD',
    operation: 'Buy',
    volume: 0.01,
    stoploss: 1.08,
    takeprofit: 1.12,
    comment: COMMENT,
  })

  const post = fake.callsTo('POST', `${ACCOUNT_PATH}/orders`)
  assert.equal(post.length, 1)
  const body = post[0]!.body!
  assert.equal(body.contingencyType, 'IF-THEN')
  const [entry, sl, tp] = body.orders as Json[]
  assert.equal(entry.type, 'MARKET')
  assert.equal(entry.instrument, 'EUR/USD')
  assert.equal(entry.quantity, '1000')
  assert.equal(entry.side, 'BUY')
  assert.equal(entry.positionEffect, 'OPEN')
  assert.ok(String(entry.orderCode).length <= 64)
  assert.equal(entry.metadata.comment, COMMENT)
  assert.equal(sl.type, 'STOP')
  assert.equal(sl.side, 'SELL')
  assert.equal(sl.quantity, '0')
  assert.equal(sl.positionEffect, 'CLOSE')
  assert.equal(sl.stopPrice, '1.08')
  assert.equal(tp.type, 'LIMIT')
  assert.equal(tp.limitPrice, '1.12')

  assert.equal(result.ticket, 5000)
  assert.equal(result.positionTicket, 5000)
  assert.equal(result.stopLoss, 1.08)
  assert.equal(result.takeProfit, 1.12)
  assert.equal(result.lots, 0.01)
  assert.equal(result.symbol, 'EUR/USD')
  assert.equal(result.openPrice, 1.1002)
  assert.equal(fake.positions.length, 1)
})

test('falls back to the entry plus protection orders when the broker rejects groups', async () => {
  const fake = new FakeDxtrade()
  fake.rejectGroups = true
  const provider = makeProvider(fake)
  const result = await provider.orderSend('acct-1', {
    symbol: 'EURUSD',
    operation: 'Sell',
    volume: 0.02,
    stoploss: 1.12,
    takeprofit: 1.08,
    comment: COMMENT,
  })

  const bodies = fake.callsTo('POST', `${ACCOUNT_PATH}/orders`).map(call => call.body!)
  assert.equal(bodies.length, 4) // rejected group, entry, SL, TP
  assert.ok(Array.isArray(bodies[0]!.orders))
  assert.equal(bodies[1]!.type, 'MARKET')
  const sl = bodies[2]!
  const tp = bodies[3]!
  assert.equal(sl.type, 'STOP')
  assert.equal(sl.positionEffect, 'CLOSE')
  assert.equal(sl.positionCode, '5000')
  assert.equal(sl.side, 'BUY')
  assert.equal(sl.stopPrice, '1.12')
  assert.equal(tp.type, 'LIMIT')
  assert.equal(tp.positionCode, '5000')
  assert.equal(tp.limitPrice, '1.08')
  assert.equal(result.stopLoss, 1.12)
  assert.equal(result.takeProfit, 1.08)
  assert.equal(result.lots, 0.02)
})

test('a margin rejection surfaces the broker reason', async () => {
  const fake = new FakeDxtrade()
  fake.rejectOrderStatus = 'REJECTED'
  const provider = makeProvider(fake)
  await assert.rejects(
    provider.orderSend('acct-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.01 }),
    /rejected the order: Not enough margin/,
  )
})

test('rejects sizes below the instrument increment and unknown symbols', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  await assert.rejects(provider.orderSend('acct-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.0001 }), /needs at least 1000 units/)
  await assert.rejects(provider.orderSend('acct-1', { symbol: 'NOPE', operation: 'Buy', volume: 1 }), /not on this DXtrade account/)
  assert.equal(fake.callsTo('POST', `${ACCOUNT_PATH}/orders`).length, 0)
})

test('a duplicate client order code resolves to the original order', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const args = { symbol: 'EURUSD', operation: 'Buy' as const, volume: 0.01, comment: COMMENT }
  const first = await provider.orderSend('acct-1', args)
  const second = await provider.orderSend('acct-1', args)
  assert.equal(second.ticket, first.ticket)
  assert.equal(fake.positions.length, 1)
  assert.equal(fake.history.filter(order => order.type === 'MARKET').length, 1)
})

test('a timeout on an order write is resolved by client id lookup, never a blind retry', async () => {
  const fake = new FakeDxtrade()
  fake.loseResponses = 1
  const provider = makeProvider(fake)
  const result = await provider.orderSend('acct-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.01, comment: COMMENT })
  assert.equal(result.ticket, 5000)
  assert.equal(fake.callsTo('POST', `${ACCOUNT_PATH}/orders`).length, 1)
  assert.equal(fake.callsTo('GET', `${ACCOUNT_PATH}/orders/history`).some(call => call.query.has('with-client-id')), true)
  assert.equal(fake.positions.length, 1)
})

test('a timeout with no trace of the order surfaces as an error', async () => {
  const fake = new FakeDxtrade()
  fake.queued.set(`POST ${ACCOUNT_PATH}/orders`, [apiError(503, 0, 'Service unavailable')])
  const provider = makeProvider(fake)
  await assert.rejects(provider.orderSend('acct-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.01 }), /Service unavailable/)
  assert.equal(fake.callsTo('POST', `${ACCOUNT_PATH}/orders`).length, 1)
})

test('places a pending limit order with protection children and reports it in opened orders', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const result = await provider.orderSend('acct-1', {
    symbol: 'EURUSD',
    operation: 'BuyLimit',
    volume: 0.01,
    price: 1.09,
    stoploss: 1.08,
    takeprofit: 1.11,
    comment: COMMENT,
  })
  assert.equal(result.state, 'Placed')
  assert.equal(result.openPrice, 1.09)
  const entry = (fake.callsTo('POST', `${ACCOUNT_PATH}/orders`)[0]!.body!.orders as Json[])[0]!
  assert.equal(entry.type, 'LIMIT')
  assert.equal(entry.limitPrice, '1.09')

  const opened = await provider.openedOrders('acct-1') as Json[]
  assert.equal(opened.length, 1)
  assert.equal(opened[0]!.operation, 'BuyLimit')
  assert.equal(opened[0]!.openPrice, 1.09)
  assert.equal(opened[0]!.stopLoss, 1.08)
  assert.equal(opened[0]!.takeProfit, 1.11)
  assert.match(opened[0]!.comment, /abcdef12/)
})

test('modifies and removes protection on a position by its position code', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const opened = await provider.orderSend('acct-1', {
    symbol: 'EURUSD', operation: 'Buy', volume: 0.01, stoploss: 1.08, takeprofit: 1.12, comment: COMMENT,
  })

  const moved = await provider.orderModify('acct-1', { ticket: opened.ticket, stoploss: 1.09 })
  assert.equal(moved.stopLoss, 1.09)
  const put = fake.callsTo('PUT', `${ACCOUNT_PATH}/orders`)
  assert.equal(put.length, 1)
  assert.equal(put[0]!.body!.positionCode, '5000')
  assert.equal(put[0]!.body!.stopPrice, '1.09')
  assert.ok(put[0]!.headers['If-Match'])
  assert.equal(fake.positions[0]!.stopLossPrice, 1.09)
  assert.equal(fake.positions[0]!.takeProfitPrice, 1.12)

  const removed = await provider.orderModify('acct-1', { ticket: opened.ticket, takeprofit: 0 })
  assert.equal(removed.takeProfit, undefined)
  assert.equal(fake.calls.filter(call => call.method === 'DELETE').length, 1)
  assert.equal(fake.positions[0]!.takeProfitPrice, undefined)
  assert.equal(fake.positions[0]!.stopLossPrice, 1.09)

  const added = await provider.orderModify('acct-1', { ticket: opened.ticket, takeprofit: 1.15 })
  assert.equal(added.takeProfit, 1.15)
  const created = fake.callsTo('POST', `${ACCOUNT_PATH}/orders`).at(-1)!.body!
  assert.equal(created.type, 'LIMIT')
  assert.equal(created.positionCode, '5000')
  assert.equal(created.limitPrice, '1.15')
})

test('an undefined or null side is left alone on modify', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const opened = await provider.orderSend('acct-1', {
    symbol: 'EURUSD', operation: 'Buy', volume: 0.01, stoploss: 1.08, takeprofit: 1.12,
  })
  const result = await provider.orderModify('acct-1', { ticket: opened.ticket, stoploss: null, takeprofit: undefined })
  assert.equal(result.stopLoss, 1.08)
  assert.equal(result.takeProfit, 1.12)
  assert.equal(fake.callsTo('PUT', `${ACCOUNT_PATH}/orders`).length, 0)
  assert.equal(fake.calls.filter(call => call.method === 'DELETE').length, 0)
})

test('retries a modify after a stale ETag (412) with a fresh one', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const opened = await provider.orderSend('acct-1', {
    symbol: 'EURUSD', operation: 'Buy', volume: 0.01, stoploss: 1.08,
  })
  fake.staleEtags = 1
  const result = await provider.orderModify('acct-1', { ticket: opened.ticket, stoploss: 1.07 })
  assert.equal(result.stopLoss, 1.07)
  assert.equal(fake.callsTo('PUT', `${ACCOUNT_PATH}/orders`).length, 2)
  assert.equal(fake.positions[0]!.stopLossPrice, 1.07)
})

test('moves a pending order price and edits its protection children', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const placed = await provider.orderSend('acct-1', {
    symbol: 'EURUSD', operation: 'BuyLimit', volume: 0.01, price: 1.09, stoploss: 1.08, takeprofit: 1.11, comment: COMMENT,
  })
  const result = await provider.orderModify('acct-1', { ticket: placed.ticket, price: 1.095, stoploss: 1.085 })
  assert.equal(result.openPrice, 1.095)
  assert.equal(result.stopLoss, 1.085)
  const puts = fake.callsTo('PUT', `${ACCOUNT_PATH}/orders`).map(call => call.body!)
  assert.equal(puts.length, 2)
  assert.equal(puts[0]!.limitPrice, '1.095')
  assert.equal(puts[0]!.positionEffect, 'OPEN')
  assert.equal(puts[1]!.stopPrice, '1.085')
  assert.equal(puts[1]!.positionEffect, 'CLOSE')
})

test('cannot add protection to a pending order that has none', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const placed = await provider.orderSend('acct-1', {
    symbol: 'EURUSD', operation: 'BuyLimit', volume: 0.01, price: 1.09,
  })
  await assert.rejects(provider.orderModify('acct-1', { ticket: placed.ticket, stoploss: 1.08 }), /placed without one/)
})

test('closes a position fully, then reports it unknown', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const opened = await provider.orderSend('acct-1', {
    symbol: 'EURUSD', operation: 'Buy', volume: 0.02, stoploss: 1.08, takeprofit: 1.12,
  })
  const closed = await provider.orderClose('acct-1', { ticket: opened.ticket })
  assert.equal(closed.state, 'position_closed')
  assert.equal(closed.lots, 0.02)
  assert.equal(closed.closePrice, 1.1)
  const body = fake.callsTo('POST', `${ACCOUNT_PATH}/orders`).at(-1)!.body!
  assert.equal(body.positionEffect, 'CLOSE')
  assert.equal(body.positionCode, '5000')
  assert.equal(body.side, 'SELL')
  assert.equal(body.type, 'MARKET')
  assert.equal(body.quantity, undefined)
  assert.ok(String(body.orderCode).startsWith('TSX_5000_'))
  assert.equal(fake.positions.length, 0)
  assert.equal(fake.working.length, 0)
  await assert.rejects(provider.orderClose('acct-1', { ticket: opened.ticket }), /unknown ticket 5000/)
})

test('closes part of a position with an explicit quantity', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const opened = await provider.orderSend('acct-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.05 })
  const partial = await provider.orderClose('acct-1', { ticket: opened.ticket, lots: 0.02 })
  assert.equal(partial.lots, 0.02)
  const body = fake.callsTo('POST', `${ACCOUNT_PATH}/orders`).at(-1)!.body!
  assert.equal(body.quantity, '2000')
  assert.equal(fake.positions[0]!.quantity, 3_000)
})

test('closing a pending order cancels it and its children', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const placed = await provider.orderSend('acct-1', {
    symbol: 'EURUSD', operation: 'SellLimit', volume: 0.01, price: 1.12, stoploss: 1.13, takeprofit: 1.1,
  })
  assert.equal(fake.working.length, 3)
  const result = await provider.orderClose('acct-1', { ticket: placed.ticket })
  assert.equal(result.state, 'position_closed')
  assert.equal(fake.working.length, 0)
  assert.equal(fake.calls.filter(call => call.method === 'DELETE').length, 3)
})

test('closed positions map from completed CLOSE orders with cash transactions', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const opened = await provider.orderSend('acct-1', {
    symbol: 'EURUSD', operation: 'Buy', volume: 0.01, comment: COMMENT,
  })
  await provider.orderClose('acct-1', { ticket: opened.ticket })

  const rows = await provider.closedOrders('acct-1') as Json[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.ticket, opened.ticket)
  assert.equal(rows[0]!.symbol, 'EUR/USD')
  assert.equal(rows[0]!.operation, 'Buy')
  assert.equal(rows[0]!.lots, 0.01)
  assert.equal(rows[0]!.profit, 12.5)
  assert.equal(rows[0]!.commission, -0.7)
  assert.equal(rows[0]!.swap, -0.1)
  assert.ok(rows[0]!.closeTime)
})

test('a position closed by its stop loss appears in history without a copier close', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const opened = await provider.orderSend('acct-1', {
    symbol: 'EURUSD', operation: 'Sell', volume: 0.01, stoploss: 1.12,
  })
  // The broker fires the stop: a COMPLETED CLOSE order appears and the position disappears.
  fake.positions = []
  fake.working = []
  fake.history.push({
    orderId: 6001,
    orderCode: '6001',
    clientOrderId: 'broker-generated',
    status: 'COMPLETED',
    finalStatus: true,
    type: 'STOP',
    instrument: 'EUR/USD',
    side: 'BUY',
    transactionTime: new Date(NOW).toISOString(),
    legs: [{ instrument: 'EUR/USD', positionEffect: 'CLOSE', positionCode: '5000', quantity: 1000, filledQuantity: 1000, averagePrice: 1.12 }],
    cashTransactions: [{ type: 'SETTLEMENT', value: -20 }],
  })
  const rows = await provider.closedOrders('acct-1') as Json[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.ticket, opened.ticket)
  assert.equal(rows[0]!.operation, 'Sell')
  assert.equal(rows[0]!.closePrice, 1.12)
  assert.equal(rows[0]!.profit, -20)
})

test('opened positions carry lots, protection and the signal comment', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  await provider.orderSend('acct-1', {
    symbol: 'XAUUSD', operation: 'Sell', volume: 0.5, stoploss: 2400, takeprofit: 2300, comment: COMMENT,
  })
  const opened = await provider.openedOrders('acct-1') as Json[]
  assert.equal(opened.length, 1)
  const row = opened[0]!
  assert.equal(row.symbol, 'XAU/USD')
  assert.equal(row.operation, 'Sell')
  assert.equal(row.lots, 0.5)
  assert.equal(row.stopLoss, 2400)
  assert.equal(row.takeProfit, 2300)
  assert.match(row.comment, /^TScopier:/)
  assert.equal(row.ticket, 5000)
})

test('rejects net-based accounts before any trading request', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake, { isPositionBased: false })
  await assert.rejects(provider.orderSend('acct-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.01 }), /net-based/)
  assert.equal(fake.calls.length, 0)
  assert.equal(await provider.keepSessionAliveDetailed('acct-1'), 'token_reconnect_failed')
})

test('mtStatus reports trade permission from the account status', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  assert.equal((await provider.mtStatus('acct-1')).account?.tradeAllowed, true)
  assert.equal(await provider.verifyTradingReady('acct-1'), true)

  fake.accountStatus = 'CLOSE_ONLY'
  const other = makeProvider(fake)
  assert.equal((await other.mtStatus('acct-1')).account?.tradeAllowed, false)
  assert.equal((await other.mtStatus('acct-1')).broker?.server, 'trade.broker.com')
})

test('keepSessionAlive pings, and a refused login asks for reconnect', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  assert.equal(await provider.keepSessionAlive('acct-1'), true)
  assert.equal(await provider.keepSessionAlive('acct-1'), true)
  assert.equal(fake.callsTo('POST', '/ping').length, 1)

  const failing = new FakeDxtrade()
  failing.queued.set('POST /login', [apiError(500, 110, 'Password expired')])
  const other = makeProvider(failing)
  assert.equal(await other.keepSessionAliveDetailed('acct-1'), 'token_reconnect_failed')
})

test('quote, symbol params and symbol list come from instruments and market data', async () => {
  const fake = new FakeDxtrade()
  const provider = makeProvider(fake)
  const quote = await provider.quote('acct-1', 'EURUSD')
  assert.equal(quote.symbol, 'EUR/USD')
  assert.equal(quote.bid, 1.1)
  assert.equal(quote.ask, 1.1002)
  const params = await provider.symbolParams('acct-1', 'EURUSD')
  assert.equal(params.symbol?.digits, 5)
  assert.equal(params.symbol?.contractSize, 100_000)
  assert.equal(params.groupParams?.minLot, 0.01)
  assert.deepEqual((await provider.symbols('acct-1')).sort(), ['EUR/USD', 'XAU/USD'])
})
