import { strict as assert } from 'node:assert'
import { beforeEach, test } from 'node:test'
import { TradelockerProvider, type TradelockerCredential } from './tradelockerProvider'
import { resetTradelockerLoginGateForTests } from './tradelocker/client'

const NOW = 1_790_000_000_000
const ACCOUNT = '555'
const BASE = '/trade/accounts/555'
const COMMENT = 'TScopier:gold:3fa85f64abcd:tp1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake broker payloads are loosely typed on purpose
type Json = Record<string, any>
type Call = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: Json | null }
type Reply = { status: number; body?: unknown }

const CREDENTIAL: TradelockerCredential = {
  accountId: 'fp-1',
  environment: 'demo',
  server: 'OSP-DEMO',
  email: 'trader@example.com',
  password: 'pw',
  tlAccountId: ACCOUNT,
  accNum: 1,
}

const instruments = [
  { tradableInstrumentId: 11, name: 'EURUSD', routes: [{ id: 101, type: 'TRADE' }, { id: 102, type: 'INFO' }] },
  { tradableInstrumentId: 12, name: 'XAU/USD', routes: [{ id: 201, type: 'TRADE' }, { id: 202, type: 'INFO' }] },
]

const details: Record<string, Json> = {
  '11': { lotSize: 100_000, lotStep: 0.01, minLot: 0.01, maxLot: 50, tickSize: 0.00001, quotingCurrency: 'USD' },
  '12': { lotSize: 100, lotStep: 0.01, minLot: 0.01, maxLot: 20, tickSize: 0.01, quotingCurrency: 'USD' },
}

const COLUMNS = {
  positionsConfig: ['id', 'tradableInstrumentId', 'routeId', 'side', 'qty', 'avgPrice', 'stopLossId', 'takeProfitId', 'openDate', 'unrealizedPl', 'strategyId'],
  ordersConfig: ['id', 'tradableInstrumentId', 'routeId', 'qty', 'side', 'type', 'status', 'filledQty', 'avgPrice', 'price', 'stopPrice', 'validity', 'createdDate', 'lastModified', 'positionId', 'stopLoss', 'takeProfit', 'strategyId'],
  ordersHistoryConfig: ['id', 'tradableInstrumentId', 'routeId', 'qty', 'side', 'type', 'status', 'filledQty', 'avgPrice', 'price', 'stopPrice', 'validity', 'createdDate', 'lastModified', 'positionId', 'stopLoss', 'takeProfit', 'strategyId', 'rejectReason'],
  accountDetailsConfig: ['balance', 'projectedBalance', 'openNetPnL', 'initialMarginReq', 'availableFunds', 'positionsCount'],
}

function json(status: number, body?: unknown): Reply {
  return { status, body }
}

function failure(status: number, errmsg: string): Reply {
  return json(status, { s: 'error', errmsg })
}

function rows(columns: string[], list: Json[]): unknown[][] {
  return list.map(item => columns.map(column => item[column] ?? null))
}

class FakeTradeLocker {
  calls: Call[] = []
  logins = 0
  refreshes = 0
  nextId = 9000
  token = 'tok-0'
  expireDate = new Date(NOW + 3_600_000).toISOString()
  accountStatus = 'ACTIVE'
  password = 'pw'
  positions: Json[] = []
  orders: Json[] = []
  history: Json[] = []
  /** The next authenticated request answers 401 once. */
  expireToken = false
  /** Place the order, then drop the response (a timeout). */
  dropAfterPlacing = 0
  /** Drop the request before it reaches the server. */
  dropBeforePlacing = 0
  /** The next N placements are refused with 429 before they reach the server. */
  rateLimitPlace = 0
  retryAfter: string | null = null
  /** Placing answers a 400 with this message. */
  rejectPlace: string | null = null
  /** Market orders are rejected with this reason. */
  rejectMarket: string | null = null
  inflight = 0
  maxInflight = 0

  fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = String(init?.method ?? 'GET')
    const headers = { ...(init?.headers as Record<string, string> | undefined) }
    const body = init?.body ? JSON.parse(String(init.body)) as Json : null
    const path = decodeURIComponent(url.pathname.replace('/backend-api', ''))
    this.calls.push({ method, path, query: url.searchParams, headers, body })
    const isPlace = method === 'POST' && path === `${BASE}/orders`
    if (isPlace) {
      if (this.rateLimitPlace > 0) {
        this.rateLimitPlace -= 1
        return new Response(JSON.stringify({ s: 'error' }), {
          status: 429,
          headers: this.retryAfter ? { 'Retry-After': this.retryAfter } : undefined,
        })
      }
      if (this.dropBeforePlacing > 0) {
        this.dropBeforePlacing -= 1
        throw new TypeError('fetch failed')
      }
      this.inflight += 1
      this.maxInflight = Math.max(this.maxInflight, this.inflight)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    try {
      const reply = this.route(method, path, url.searchParams, headers, body)
      if (isPlace && this.dropAfterPlacing > 0 && reply.status === 200) {
        this.dropAfterPlacing -= 1
        throw new TypeError('fetch failed')
      }
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status })
    } finally {
      if (isPlace) this.inflight -= 1
    }
  }) as typeof fetch

  callsTo(method: string, path: string): Call[] {
    return this.calls.filter(call => call.method === method && call.path === path)
  }

  private route(method: string, path: string, query: URLSearchParams, headers: Record<string, string>, body: Json | null): Reply {
    if (method === 'POST' && path === '/auth/jwt/token') {
      if (body?.password !== this.password) return failure(401, 'Invalid credentials')
      this.logins += 1
      this.token = `tok-${this.logins}`
      return json(200, { accessToken: this.token, refreshToken: `ref-${this.logins}`, expireDate: this.expireDate })
    }
    if (method === 'POST' && path === '/auth/jwt/refresh') {
      this.refreshes += 1
      this.token = `tok-r${this.refreshes}`
      this.expireDate = new Date(NOW + 3_600_000).toISOString()
      return json(200, { accessToken: this.token, refreshToken: `ref-r${this.refreshes}`, expireDate: this.expireDate })
    }
    if (this.expireToken) {
      this.expireToken = false
      this.token = 'revoked'
    }
    if (headers.Authorization !== `Bearer ${this.token}`) return failure(401, 'Token expired')

    if (method === 'GET' && path === '/auth/jwt/all-accounts') {
      return json(200, { accounts: [{ id: ACCOUNT, accNum: 1, name: 'Demo', currency: 'USD', status: this.accountStatus, accountBalance: 1000 }] })
    }
    if (!headers.accNum) return failure(400, 'accNum header is required')
    if (method === 'GET' && path === '/trade/config') {
      const d: Json = {}
      for (const [name, columns] of Object.entries(COLUMNS)) d[name] = { columns: columns.map(id => ({ id })) }
      return json(200, { s: 'ok', d })
    }
    if (method === 'GET' && path === `${BASE}/state`) {
      return json(200, { s: 'ok', d: { accountDetailsData: [1000, 1010, 10, 20, 990, this.positions.length] } })
    }
    if (method === 'GET' && path === `${BASE}/instruments`) return json(200, { s: 'ok', d: { instruments } })
    const detail = /^\/trade\/instruments\/(\d+)$/.exec(path)
    if (method === 'GET' && detail) return json(200, { s: 'ok', d: details[detail[1]!] })
    if (method === 'GET' && path === '/trade/quotes') return json(200, { s: 'ok', d: { bp: 1.1, ap: 1.1002 } })
    if (method === 'GET' && path === `${BASE}/positions`) {
      return json(200, { s: 'ok', d: { positions: rows(COLUMNS.positionsConfig, this.positions) } })
    }
    if (method === 'GET' && path === `${BASE}/orders`) {
      return json(200, { s: 'ok', d: { orders: rows(COLUMNS.ordersConfig, this.orders) } })
    }
    if (method === 'GET' && path === `${BASE}/ordersHistory`) {
      return json(200, { s: 'ok', d: { ordersHistory: rows(COLUMNS.ordersHistoryConfig, this.history) } })
    }
    if (method === 'POST' && path === `${BASE}/orders`) return this.place(body!)

    const position = /^\/trade\/positions\/(\d+)$/.exec(path)
    if (position && method === 'PATCH') return this.patchPosition(position[1]!, body!)
    if (position && method === 'DELETE') return this.closePosition(position[1]!, Number(body?.qty ?? 0))
    const order = /^\/trade\/orders\/(\d+)$/.exec(path)
    if (order && method === 'PATCH') return this.patchOrder(order[1]!, body!)
    if (order && method === 'DELETE') {
      this.orders = this.orders.filter(item => item.id !== order[1])
      return json(200, { s: 'ok' })
    }
    return failure(404, `no route ${method} ${path}`)
  }

  private protectionOrder(positionId: string, type: 'stop' | 'limit', side: string, price: number): Json {
    const id = String(this.nextId++)
    const row: Json = {
      id,
      tradableInstrumentId: 11,
      qty: 0,
      side,
      type,
      status: 'Placed',
      positionId,
      ...(type === 'stop' ? { stopPrice: price } : { price }),
    }
    this.orders.push(row)
    return row
  }

  private openPosition(order: Json, price: number): Json {
    const positionId = String(this.nextId++)
    const opposite = order.side === 'buy' ? 'sell' : 'buy'
    const position: Json = {
      id: positionId,
      tradableInstrumentId: order.tradableInstrumentId,
      routeId: order.routeId,
      side: order.side,
      qty: order.qty,
      avgPrice: price,
      openDate: NOW,
      strategyId: order.strategyId,
    }
    if (order.stopLoss) position.stopLossId = this.protectionOrder(positionId, 'stop', opposite, order.stopLoss).id
    if (order.takeProfit) position.takeProfitId = this.protectionOrder(positionId, 'limit', opposite, order.takeProfit).id
    this.positions.push(position)
    this.history.push({
      ...order,
      status: 'Filled',
      filledQty: order.qty,
      avgPrice: price,
      positionId,
      createdDate: NOW,
      lastModified: NOW,
    })
    return position
  }

  private place(body: Json): Reply {
    if (this.rejectPlace) return failure(400, this.rejectPlace)
    for (const key of ['qty', 'routeId', 'tradableInstrumentId', 'side', 'type', 'validity']) {
      if (body[key] === undefined) return failure(400, `${key} is required`)
    }
    if (String(body.strategyId ?? '').length > 31) return failure(400, 'strategyId too long')
    const id = String(this.nextId++)
    const order: Json = {
      id,
      tradableInstrumentId: body.tradableInstrumentId,
      routeId: body.routeId,
      qty: body.qty,
      side: body.side,
      type: body.type,
      validity: body.validity,
      price: body.price,
      stopPrice: body.stopPrice,
      stopLoss: body.stopLoss,
      takeProfit: body.takeProfit,
      strategyId: body.strategyId,
      createdDate: NOW,
    }
    if (body.type === 'market') {
      if (this.rejectMarket) {
        this.history.push({ ...order, status: 'Rejected', filledQty: 0, rejectReason: this.rejectMarket })
      } else {
        this.openPosition(order, body.side === 'buy' ? 1.1002 : 1.1)
      }
    } else {
      this.orders.push({ ...order, status: 'Placed', positionId: '' })
    }
    return json(200, { s: 'ok', d: { orderId: id } })
  }

  /** The broker fills a working order: it leaves the book and a position with a new id appears. */
  fillPending(orderId: string, price: number): Json {
    const order = this.orders.find(item => item.id === orderId)!
    this.orders = this.orders.filter(item => item.id !== orderId)
    return this.openPosition(order, price)
  }

  private patchPosition(id: string, body: Json): Reply {
    const position = this.positions.find(item => item.id === id)
    if (!position) return failure(404, 'position not found')
    const opposite = position.side === 'buy' ? 'sell' : 'buy'
    const apply = (key: 'stopLoss' | 'takeProfit', idKey: 'stopLossId' | 'takeProfitId', type: 'stop' | 'limit') => {
      if (!(key in body)) return
      if (position[idKey]) this.orders = this.orders.filter(item => item.id !== position[idKey])
      position[idKey] = body[key] == null ? undefined : this.protectionOrder(id, type, opposite, body[key]).id
    }
    apply('stopLoss', 'stopLossId', 'stop')
    apply('takeProfit', 'takeProfitId', 'limit')
    return json(200, { s: 'ok' })
  }

  private patchOrder(id: string, body: Json): Reply {
    const order = this.orders.find(item => item.id === id)
    if (!order) return failure(404, 'order not found')
    Object.assign(order, body)
    return json(200, { s: 'ok' })
  }

  private closePosition(id: string, qty: number): Reply {
    const position = this.positions.find(item => item.id === id)
    if (!position) return failure(404, 'position not found')
    const closed = qty > 0 && qty < position.qty ? qty : position.qty
    this.history.push({
      id: String(this.nextId++),
      tradableInstrumentId: position.tradableInstrumentId,
      side: position.side === 'buy' ? 'sell' : 'buy',
      type: 'market',
      status: 'Filled',
      qty: closed,
      filledQty: closed,
      avgPrice: 1.105,
      positionId: id,
      createdDate: NOW + 1000,
      lastModified: NOW + 1000,
    })
    if (closed < position.qty) {
      position.qty = Number((position.qty - closed).toFixed(8))
    } else {
      this.orders = this.orders.filter(item => item.positionId !== id)
      this.positions = this.positions.filter(item => item.id !== id)
    }
    return json(200, { s: 'ok' })
  }
}

let fake: FakeTradeLocker

function provider(overrides: { loadCredentials?: () => Promise<TradelockerCredential | null> } = {}): TradelockerProvider {
  return new TradelockerProvider({
    loadCredentials: overrides.loadCredentials ?? (async () => CREDENTIAL),
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    sleep: async () => {},
    clientOptions: { developerKey: '' },
  })
}

beforeEach(() => {
  fake = new FakeTradeLocker()
  resetTradelockerLoginGateForTests()
})

test('logs in once, sends accNum on trade routes only, and maps array rows by config column', async () => {
  const tl = provider()
  fake.positions.push({ id: '700', tradableInstrumentId: 11, side: 'buy', qty: 0.5, avgPrice: 1.09, openDate: NOW - 5000, strategyId: 'TSC.3fa85f64abcd.x.y' })
  const open = await tl.openedOrders('fp-1') as Json[]
  assert.equal(fake.logins, 1)
  assert.equal(open.length, 1)
  assert.equal(open[0]!.ticket, 700)
  assert.equal(open[0]!.symbol, 'EURUSD')
  assert.equal(open[0]!.operation, 'Buy')
  assert.equal(open[0]!.lots, 0.5)
  assert.equal(open[0]!.openPrice, 1.09)
  assert.equal(open[0]!.comment, 'TScopier:3fa85f64abcd')
  assert.equal(fake.calls.find(call => call.path === '/auth/jwt/token')!.headers.accNum, undefined)
  for (const call of fake.calls.filter(item => item.path.startsWith('/trade/'))) assert.equal(call.headers.accNum, '1', call.path)
  await tl.openedOrders('fp-1')
  assert.equal(fake.logins, 1)
})

test('open positions resolve SL and TP from their protection orders and hide them from the pending list', async () => {
  const tl = provider()
  await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, stoploss: 1.09, takeprofit: 1.11, comment: COMMENT })
  await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'BuyLimit', volume: 0.1, price: 1.05, stoploss: 1.04 })
  const open = await tl.openedOrders('fp-1') as Json[]
  assert.equal(open.length, 2)
  const position = open.find(row => row.positionTicket)!
  assert.equal(position.stopLoss, 1.09)
  assert.equal(position.takeProfit, 1.11)
  assert.equal(position.comment, 'TScopier:3fa85f64abcd')
  const pending = open.find(row => row.state === 'Placed')!
  assert.equal(pending.operation, 'BuyLimit')
  assert.equal(pending.openPrice, 1.05)
  assert.equal(pending.stopLoss, 1.04)
})

test('a market order carries lots, route, SL/TP and a short strategyId, and returns the position ticket', async () => {
  const tl = provider()
  const result = await tl.orderSend('fp-1', {
    symbol: 'EURUSD',
    operation: 'Buy',
    volume: 0.237,
    stoploss: 1.0950004,
    takeprofit: 1.11,
    comment: COMMENT,
  })
  const posts = fake.callsTo('POST', `${BASE}/orders`)
  assert.equal(posts.length, 1)
  const body = posts[0]!.body!
  assert.equal(body.qty, 0.23)
  assert.equal(body.side, 'buy')
  assert.equal(body.type, 'market')
  assert.equal(body.validity, 'IOC')
  assert.equal(body.routeId, 101)
  assert.equal(body.tradableInstrumentId, 11)
  assert.equal(body.stopLoss, 1.095)
  assert.equal(body.stopLossType, 'absolute')
  assert.equal(body.takeProfit, 1.11)
  assert.equal(body.takeProfitType, 'absolute')
  assert.match(body.strategyId, /^TSC\.3fa85f64abcd\./)
  assert.ok(String(body.strategyId).length <= 31)
  assert.equal(result.positionTicket, Number(fake.positions[0]!.id))
  assert.equal(result.ticket, result.positionTicket)
  assert.notEqual(result.orderTicket, result.positionTicket)
  assert.equal(result.openPrice, 1.1002)
  assert.equal(result.lots, 0.23)
  assert.equal(result.stopLoss, 1.095)
  assert.equal(result.takeProfit, 1.11)
})

test('a size below the instrument minimum is refused before anything is sent', async () => {
  const tl = provider()
  await assert.rejects(tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.004 }), /at least 0\.01/)
  assert.equal(fake.callsTo('POST', `${BASE}/orders`).length, 0)
  await assert.rejects(tl.orderSend('fp-1', { symbol: 'NOPE', operation: 'Buy', volume: 0.1 }), /not on this TradeLocker account/)
})

test('a rejected market order surfaces the broker reason', async () => {
  const tl = provider()
  fake.rejectMarket = 'Not enough margin'
  await assert.rejects(tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 }), /rejected the order: Not enough margin/)
  assert.equal(fake.positions.length, 0)
})

test('an API error on placing is thrown as is and does not block a later attempt', async () => {
  const tl = provider()
  fake.rejectPlace = 'Market is closed'
  await assert.rejects(tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 }), /Market is closed/)
  assert.equal(fake.positions.length, 0)
  fake.rejectPlace = null
  const result = await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 })
  assert.equal(fake.callsTo('POST', `${BASE}/orders`).length, 2)
  assert.equal(result.positionTicket, Number(fake.positions[0]!.id))
})

test('a pending order keeps its order ticket until it fills, then modify and close follow it to the position', async () => {
  const tl = provider()
  const placed = await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'BuyLimit', volume: 0.1, price: 1.09, comment: COMMENT })
  const body = fake.callsTo('POST', `${BASE}/orders`)[0]!.body!
  assert.equal(body.type, 'limit')
  assert.equal(body.price, 1.09)
  assert.equal(body.validity, 'GTC')
  assert.equal(body.stopPrice, undefined)
  assert.equal(placed.state, 'Placed')
  assert.equal(placed.ticket, placed.orderTicket)
  assert.equal(fake.positions.length, 0)

  const position = fake.fillPending(String(placed.ticket), 1.09)
  assert.notEqual(Number(position.id), placed.ticket)

  const modified = await tl.orderModify('fp-1', { ticket: placed.ticket, stoploss: 1.08 })
  assert.equal(modified.stopLoss, 1.08)
  const patch = fake.callsTo('PATCH', `/trade/positions/${position.id}`)
  assert.equal(patch.length, 1)
  assert.deepEqual(patch[0]!.body, { stopLoss: 1.08 })

  const partial = await tl.orderClose('fp-1', { ticket: placed.ticket, lots: 0.04 })
  assert.deepEqual(fake.callsTo('DELETE', `/trade/positions/${position.id}`)[0]!.body, { qty: 0.04 })
  assert.equal(partial.lots, 0.04)
  assert.equal(partial.closePrice, 1.105)
  assert.equal(fake.positions[0]!.qty, 0.06)

  const full = await tl.orderClose('fp-1', { ticket: placed.ticket })
  assert.deepEqual(fake.callsTo('DELETE', `/trade/positions/${position.id}`)[1]!.body, { qty: 0 })
  assert.equal(full.lots, 0.06)
  assert.equal(fake.positions.length, 0)
})

test('modifying a position sets one side, removes the other, and leaves an untouched side out of the request', async () => {
  const tl = provider()
  const opened = await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Sell', volume: 0.1, stoploss: 1.12, takeprofit: 1.08 })
  await tl.orderModify('fp-1', { ticket: opened.ticket, stoploss: 0, takeprofit: 1.07 })
  const patch = fake.callsTo('PATCH', `/trade/positions/${fake.positions[0]!.id}`)
  assert.deepEqual(patch[0]!.body, { stopLoss: null, takeProfit: 1.07 })
  await tl.orderModify('fp-1', { ticket: opened.ticket })
  assert.equal(fake.callsTo('PATCH', `/trade/positions/${fake.positions[0]!.id}`).length, 1)
})

test('modifying a pending order sends its quantity, type and the changed prices; closing it cancels it', async () => {
  const tl = provider()
  const placed = await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'SellStop', volume: 0.1, price: 1.08, stoploss: 1.09 })
  assert.equal(fake.callsTo('POST', `${BASE}/orders`)[0]!.body!.stopPrice, 1.08)
  await tl.orderModify('fp-1', { ticket: placed.ticket, price: 1.075, stoploss: 0, takeprofit: 1.05 })
  const patch = fake.callsTo('PATCH', `/trade/orders/${placed.ticket}`)[0]!.body!
  assert.equal(patch.qty, 0.1)
  assert.equal(patch.type, 'stop')
  assert.equal(patch.stopPrice, 1.075)
  assert.equal(patch.stopLoss, null)
  assert.equal(patch.takeProfit, 1.05)
  assert.equal(patch.takeProfitType, 'absolute')

  const closed = await tl.orderClose('fp-1', { ticket: placed.ticket })
  assert.equal(closed.state, 'position_closed')
  assert.equal(fake.callsTo('DELETE', `/trade/orders/${placed.ticket}`).length, 1)
  assert.equal(fake.orders.length, 0)
})

test('an order whose answer was lost is found by its strategyId and never sent twice', async () => {
  const tl = provider()
  fake.dropAfterPlacing = 1
  const result = await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  assert.equal(fake.callsTo('POST', `${BASE}/orders`).length, 1)
  assert.equal(fake.positions.length, 1)
  assert.equal(result.positionTicket, Number(fake.positions[0]!.id))
})

function providerRecordingSleeps(sleeps: number[]): TradelockerProvider {
  return new TradelockerProvider({
    loadCredentials: async () => CREDENTIAL,
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    sleep: async ms => { sleeps.push(ms) },
    clientOptions: { developerKey: '' },
  })
}

test('an order refused with 429 is retried after a back-off and opens exactly one position', async () => {
  const sleeps: number[] = []
  const tl = providerRecordingSleeps(sleeps)
  fake.rateLimitPlace = 2
  const result = await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  assert.equal(fake.callsTo('POST', `${BASE}/orders`).length, 3)
  assert.equal(fake.positions.length, 1)
  assert.equal(result.positionTicket, Number(fake.positions[0]!.id))
  // 1s then 2s, taken as a pause for the whole client.
  assert.ok(sleeps.includes(1000), `sleeps ${sleeps.join(',')}`)
  assert.ok(sleeps.includes(2000), `sleeps ${sleeps.join(',')}`)
})

test('a 429 Retry-After is honoured', async () => {
  const sleeps: number[] = []
  const tl = providerRecordingSleeps(sleeps)
  fake.rateLimitPlace = 1
  fake.retryAfter = '3'
  await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  assert.ok(sleeps.includes(3000), `sleeps ${sleeps.join(',')}`)
  assert.equal(fake.positions.length, 1)
})

test('a persistent 429 gives up after the retries with a rate-limit message and opens nothing', async () => {
  const tl = provider()
  fake.rateLimitPlace = 99
  await assert.rejects(
    tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT }),
    /rate limiting requests/,
  )
  assert.equal(fake.callsTo('POST', `${BASE}/orders`).length, 4)
  assert.equal(fake.positions.length, 0)
})

test('an order that never arrived is reported as unconfirmed, and a repeat is reconciled before it is sent', async () => {
  const tl = provider()
  fake.dropBeforePlacing = 1
  await assert.rejects(tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT }), /did not confirm order TSC\./)
  assert.equal(fake.positions.length, 0)
  const positionsReadsBefore = fake.callsTo('GET', `${BASE}/positions`).length

  const result = await tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  assert.equal(fake.positions.length, 1)
  assert.equal(result.positionTicket, Number(fake.positions[0]!.id))
  // The repeat looked for the tag first (positions were read before the POST went out).
  assert.ok(fake.callsTo('GET', `${BASE}/positions`).length > positionsReadsBefore)
})

test('a repeat of an order that did land returns it instead of opening a second position', async () => {
  fake.dropAfterPlacing = 1
  // The first attempt landed but the lookup is made to fail, so it stays uncertain.
  const original = fake.fetchImpl
  let failReads = 1
  fake.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (failReads > 0 && String(init?.method ?? 'GET') === 'GET' && /\/(positions|orders|ordersHistory)$/.test(url)) {
      failReads -= 1
      throw new TypeError('fetch failed')
    }
    return original(input, init)
  }) as typeof fetch
  const flaky = new TradelockerProvider({ loadCredentials: async () => CREDENTIAL, fetchImpl: fake.fetchImpl, now: () => NOW, sleep: async () => {}, clientOptions: { developerKey: '' } })
  await assert.rejects(flaky.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT }), /did not confirm|fetch|Could not reach/i)
  assert.equal(fake.positions.length, 1)
  const again = await flaky.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  assert.equal(fake.callsTo('POST', `${BASE}/orders`).length, 1)
  assert.equal(fake.positions.length, 1)
  assert.equal(again.positionTicket, Number(fake.positions[0]!.id))
})

test('orders on one account are written one at a time', async () => {
  const tl = provider()
  await Promise.all([
    tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 }),
    tl.orderSend('fp-1', { symbol: 'XAUUSD', operation: 'Sell', volume: 0.1 }),
    tl.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Sell', volume: 0.2 }),
  ])
  assert.equal(fake.maxInflight, 1)
  assert.equal(fake.positions.length, 3)
  assert.equal(fake.positions.find(p => p.tradableInstrumentId === 12)!.side, 'sell')
})

test('a 401 triggers one re-login and the request is retried', async () => {
  const tl = provider()
  await tl.openedOrders('fp-1')
  assert.equal(fake.logins, 1)
  fake.expireToken = true
  await tl.openedOrders('fp-1')
  assert.equal(fake.logins, 2)
})

test('a token near expiry is refreshed instead of logging in again', async () => {
  const tl = provider()
  fake.expireDate = new Date(NOW + 30_000).toISOString()
  await tl.openedOrders('fp-1')
  assert.equal(fake.logins, 1)
  await tl.openedOrders('fp-1')
  assert.equal(fake.refreshes, 1)
  assert.equal(fake.logins, 1)
})

test('account summary, status and trading readiness come from the account state', async () => {
  const tl = provider()
  const summary = await tl.accountSummary('fp-1')
  assert.deepEqual(summary, { balance: 1000, equity: 1010, profit: 10, margin: 20, freeMargin: 990, currency: 'USD', synced: true })
  const status = await tl.mtStatus('fp-1')
  assert.equal(status.account?.tradeAllowed, true)
  assert.equal(status.broker?.server, 'OSP-DEMO')
  assert.equal(await tl.verifyTradingReady('fp-1'), true)

  fake.accountStatus = 'SUSPENDED'
  assert.equal(await tl.verifyTradingReady('fp-1'), false)
  assert.equal((await tl.terminalStatus('fp-1')).tradeAllowed, false)
})

test('quote and symbol parameters use the INFO route and the instrument details', async () => {
  const tl = provider()
  assert.deepEqual(await tl.quote('fp-1', 'EURUSD'), { symbol: 'EURUSD', bid: 1.1, ask: 1.1002 })
  const quoteCall = fake.callsTo('GET', '/trade/quotes')[0]!
  assert.equal(quoteCall.query.get('routeId'), '102')
  assert.equal(quoteCall.query.get('tradableInstrumentId'), '11')

  const params = await tl.symbolParams('fp-1', 'XAUUSD')
  assert.equal(params.symbolName, 'XAU/USD')
  assert.equal(params.symbol?.digits, 2)
  assert.equal(params.symbol?.contractSize, 100)
  assert.deepEqual(params.groupParams, { minLot: 0.01, maxLot: 20, lotStep: 0.01 })
})

test('closed trades come from order history, with a gross profit only when no conversion is needed', async () => {
  const tl = provider()
  fake.history.push(
    { id: '800', tradableInstrumentId: 11, side: 'sell', type: 'market', status: 'Filled', qty: 0.1, filledQty: 0.1, avgPrice: 1.09, positionId: '700', createdDate: NOW - 60_000, lastModified: NOW - 60_000, strategyId: 'TSC.3fa85f64abcd.a.b', stopLoss: 1.1, takeProfit: 1.08 },
    { id: '801', tradableInstrumentId: 11, side: 'buy', type: 'market', status: 'Filled', qty: 0.1, filledQty: 0.1, avgPrice: 1.085, positionId: '700', createdDate: NOW - 1000, lastModified: NOW - 500 },
    { id: '802', tradableInstrumentId: 11, side: 'buy', type: 'limit', status: 'Cancelled', qty: 0.1, filledQty: 0, positionId: '', createdDate: NOW - 2000 },
  )
  const closed = await tl.closedOrders('fp-1') as Json[]
  assert.equal(closed.length, 1)
  assert.equal(closed[0]!.ticket, 700)
  assert.equal(closed[0]!.symbol, 'EURUSD')
  assert.equal(closed[0]!.operation, 'Sell')
  assert.equal(closed[0]!.openPrice, 1.09)
  assert.equal(closed[0]!.closePrice, 1.085)
  assert.equal(closed[0]!.profit, 50)
  assert.equal(closed[0]!.comment, 'TScopier:3fa85f64abcd')
  assert.equal(closed[0]!.stopLoss, 1.1)
  assert.equal(closed[0]!.closeTime, new Date(NOW - 500).toISOString())

  const page = await tl.orderHistoryPage('fp-1', new Date(NOW - 86_400_000).toISOString(), new Date(NOW).toISOString())
  assert.equal(page.pagesCount, 1)
  assert.equal(page.orders.length, 1)

  // A different account currency means no conversion rate is known, so no profit is invented.
  fake.accountStatus = 'ACTIVE'
  const eur = new TradelockerProvider({
    loadCredentials: async () => CREDENTIAL,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fake.fetchImpl(input, init)
      if (String(input).endsWith('/auth/jwt/all-accounts')) {
        return new Response(JSON.stringify({ accounts: [{ id: ACCOUNT, accNum: 1, currency: 'EUR', status: 'ACTIVE' }] }), { status: 200 })
      }
      return response
    }) as typeof fetch,
    now: () => NOW,
    sleep: async () => {},
    clientOptions: { developerKey: '' },
  })
  const eurClosed = await eur.closedOrders('fp-1') as Json[]
  assert.equal(eurClosed[0]!.profit, undefined)
})

test('bad credentials fail the session check without leaking the password', async () => {
  fake.password = 'different'
  const tl = provider()
  await assert.rejects(tl.ensureConnected('fp-1'), error => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /pw/)
    return true
  })
  assert.equal(await tl.keepSessionAliveDetailed('fp-1'), 'token_reconnect_failed')
  const account = await tl.getV1Account('fp-1')
  assert.equal(account.status, 'error')
})

test('an account without stored credentials is not configured', async () => {
  const tl = provider({ loadCredentials: async () => null })
  await assert.rejects(tl.openedOrders('missing'), /not configured/)
  assert.equal(await tl.keepSessionAliveDetailed('missing'), 'token_reconnect_failed')
})

test('keepSessionAlive reports alive for a working login and the provider cannot connect with a password', async () => {
  const tl = provider()
  assert.equal(await tl.keepSessionAlive('fp-1'), true)
  await assert.rejects(tl.connectEx(), /stored login/)
})

test('unknown tickets are reported clearly', async () => {
  const tl = provider()
  await assert.rejects(tl.orderClose('fp-1', { ticket: 424242 }), /unknown ticket 424242/)
  await assert.rejects(tl.orderModify('fp-1', { ticket: 424242, stoploss: 1 }), /unknown ticket 424242/)
})
