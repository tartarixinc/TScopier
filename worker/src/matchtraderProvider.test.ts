import { strict as assert } from 'node:assert'
import { beforeEach, test } from 'node:test'
import { MatchtraderProvider, type MatchtraderCredential, type MatchtraderProviderOptions, type MatchtraderTagStore } from './matchtraderProvider'
import { resetMatchtraderLoginGateForTests } from './matchtrader/client'
import { tagKey, type TagEntry } from './matchtrader/symbols'

const NOW = 1_790_000_000_000
const HOST = 'https://trade.broker.com'
const SYS = 'sys-1'
const ACC = 'acc-1'
const API = 'api-1'
const PREFIX = `/mtr-api/${SYS}`
const COMMENT = 'TScopier:gold:3fa85f64abcd:tp1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake broker payloads are loosely typed on purpose
type Json = Record<string, any>
type Call = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: Json | null }
type Reply = { status: number; body?: unknown; cookies?: string[] }

const CREDENTIAL: MatchtraderCredential = {
  accountId: 'fp-1',
  brokerAccountId: 'ba-1',
  serverUrl: HOST,
  brokerId: '42',
  email: 'trader@example.com',
  password: 'pw',
  tradingAccountUuid: ACC,
  systemUuid: SYS,
}

const instruments = [
  {
    symbol: 'EURUSD', alias: 'EURUSD', volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, volumePrecision: 2,
    contractSize: 100_000, pricePrecision: 5, sizeOfOnePoint: 0.00001, quoteCurrency: 'USD',
  },
  {
    symbol: 'XAUUSD.x', alias: 'XAUUSD', volumeMin: 0.01, volumeMax: 20, volumeStep: 0.01, volumePrecision: 2,
    contractSize: 100, pricePrecision: 2, sizeOfOnePoint: 0.01, quoteCurrency: 'USD',
  },
]

/** Server timestamps carry no zone. */
function zoneless(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19)
}

class FakeMatchTrader {
  calls: Call[] = []
  logins = 0
  refreshes = 0
  nextId = 9000
  token = 'tok-0'
  password = 'pw'
  tfa = false
  positions: Json[] = []
  orders: Json[] = []
  closed: Json[] = []
  /** The login token never works, only the per-account token does. */
  acceptAltOnly = false
  /** The next trading request finds its token revoked. */
  expireToken = false
  /** Writes (by route) that apply but whose answer is lost. */
  dropAfter = new Map<string, number>()
  /** Writes (by route) that never reach the broker. */
  dropBefore = new Map<string, number>()
  /** After a dropped answer, this many reads of open positions fail. */
  failReadsAfterDrop = 0
  failReads = 0
  /** The write answers 200 with a non-OK status. */
  rejectWrite: string | null = null
  /** The position id differs from the order id the open call returns. */
  positionIdsDiffer = false
  rateLimitOnce = false
  inflight = 0
  maxInflight = 0

  fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = String(init?.method ?? 'GET')
    const headers = { ...(init?.headers as Record<string, string> | undefined) }
    const body = init?.body ? JSON.parse(String(init.body)) as Json : null
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname
    this.calls.push({ method, path, query: url.searchParams, headers, body })
    const isPlace = method === 'POST' && (path === '/position/open' || path === '/pending-order/create')
    if (this.failReads > 0 && method === 'GET' && path === '/open-positions') {
      this.failReads -= 1
      throw new TypeError('fetch failed')
    }
    const before = this.dropBefore.get(path) ?? 0
    if (method === 'POST' && before > 0) {
      this.dropBefore.set(path, before - 1)
      throw new TypeError('fetch failed')
    }
    if (isPlace) {
      this.inflight += 1
      this.maxInflight = Math.max(this.maxInflight, this.inflight)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    try {
      const reply = this.route(method, url.pathname, path, headers, body)
      const after = this.dropAfter.get(path) ?? 0
      if (method === 'POST' && after > 0 && reply.status === 200) {
        this.dropAfter.set(path, after - 1)
        this.failReads = this.failReadsAfterDrop
        throw new TypeError('fetch failed')
      }
      const responseHeaders = new Headers()
      for (const cookie of reply.cookies ?? []) responseHeaders.append('set-cookie', cookie)
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: responseHeaders })
    } finally {
      if (isPlace) this.inflight -= 1
    }
  }) as typeof fetch

  callsTo(method: string, path: string): Call[] {
    return this.calls.filter(call => call.method === method && call.path === path)
  }

  private validToken(): string {
    return this.acceptAltOnly ? 'acctok' : this.token
  }

  private route(method: string, fullPath: string, path: string, headers: Record<string, string>, body: Json | null): Reply {
    if (method === 'POST' && path === '/manager/mtr-login') {
      if (body?.password !== this.password) return { status: 401, body: { errorMessage: 'Invalid credentials' } }
      if (body?.brokerId !== '42') return { status: 400, body: { errorMessage: 'Unknown broker' } }
      this.logins += 1
      this.token = `tok-${this.logins}`
      return {
        status: 200,
        cookies: [`co-auth=${this.token}; Path=/; HttpOnly`],
        body: {
          token: this.token,
          selectedTradingAccount: { uuid: ACC },
          tfaConfig: { isEnabledForSignIn: this.tfa },
          tradingAccounts: [{
            uuid: ACC,
            tradingAccountId: '555',
            tradingApiToken: API,
            tradingAccountToken: { token: 'acctok', expiration: 0 },
            offer: { demo: true, currency: 'USD', system: { uuid: SYS } },
          }],
        },
      }
    }
    if (method === 'POST' && path === '/manager/refresh-token') {
      const cookie = /(?:^|;\s*)co-auth=([^;]*)/.exec(headers.Cookie ?? '')?.[1]
      if (cookie !== this.token) return { status: 401, body: { errorMessage: 'Refresh denied' } }
      this.refreshes += 1
      this.token = `tok-r${this.refreshes}`
      return { status: 200, cookies: [`co-auth=${this.token}; Path=/; HttpOnly`], body: { token: this.token } }
    }
    if (!fullPath.startsWith(`${PREFIX}/`)) return { status: 404, body: { errorMessage: `no route ${method} ${fullPath}` } }

    if (this.expireToken) {
      this.expireToken = false
      this.token = 'revoked'
    }
    const cookie = /(?:^|;\s*)co-auth=([^;]*)/.exec(headers.Cookie ?? '')?.[1]
    if (headers['Auth-trading-api'] !== API || cookie !== this.validToken()) {
      return { status: 401, body: { errorMessage: 'Unauthorized' } }
    }
    if (this.rateLimitOnce && method === 'GET') {
      this.rateLimitOnce = false
      return { status: 429, body: { errorMessage: 'Too many requests' } }
    }

    if (method === 'GET' && path === '/balance') {
      return { status: 200, body: { balance: 1000, equity: 1010, profit: 10, margin: 20, freeMargin: 990, currency: 'USD' } }
    }
    if (method === 'GET' && path === '/effective-instruments') return { status: 200, body: instruments }
    if (method === 'GET' && path === '/open-positions') return { status: 200, body: { positions: this.positions } }
    if (method === 'GET' && path === '/active-orders') return { status: 200, body: { orders: this.orders } }
    if (method === 'GET' && path === '/quotations') return { status: 200, body: [{ symbol: 'EURUSD', bid: 1.1, ask: 1.1002 }] }
    if (method === 'POST' && path === '/closed-positions') return { status: 200, body: { operations: this.closed } }

    if (method !== 'POST') return { status: 404, body: { errorMessage: `no route ${method} ${path}` } }
    if (this.rejectWrite) return { status: 200, body: { status: 'ERROR', nativeCode: 'E1', errorMessage: this.rejectWrite } }
    switch (path) {
      case '/position/open': return this.ok(this.openPosition(body!))
      case '/pending-order/create': return this.ok(this.createPending(body!))
      case '/position/edit': return this.editPosition(body!)
      case '/position/close': return this.closePosition(body!, false)
      case '/position/close-partially': return this.closePosition(body!, true)
      case '/pending-order/edit': return this.editPending(body!)
      case '/pending-order/cancel': return this.cancelPending(body!)
      default: return { status: 404, body: { errorMessage: `no route ${method} ${path}` } }
    }
  }

  private ok(orderId = ''): Reply {
    return { status: 200, body: { status: 'OK', nativeCode: '0', errorMessage: '', orderId } }
  }

  private newId(): string {
    return `W${this.nextId++}`
  }

  private openPosition(body: Json): string {
    const orderId = this.newId()
    const id = this.positionIdsDiffer ? this.newId() : orderId
    this.positions.push({
      id,
      symbol: body.instrument,
      side: body.orderSide,
      volume: body.volume,
      openPrice: body.orderSide === 'BUY' ? 1.1002 : 1.1,
      stopLoss: body.slPrice || 0,
      takeProfit: body.tpPrice || 0,
      openTime: zoneless(NOW),
    })
    return orderId
  }

  private createPending(body: Json): string {
    const id = this.newId()
    this.orders.push({
      id,
      symbol: body.instrument,
      side: body.orderSide,
      volume: body.volume,
      type: body.type,
      activationPrice: body.price,
      stopLoss: body.slPrice || 0,
      takeProfit: body.tpPrice || 0,
      creationTime: zoneless(NOW),
    })
    return id
  }

  private editPosition(body: Json): Reply {
    const row = this.positions.find(item => item.id === body.id)
    if (!row) return { status: 200, body: { status: 'ERROR', errorMessage: 'position not found' } }
    row.stopLoss = body.slPrice
    row.takeProfit = body.tpPrice
    return this.ok()
  }

  private editPending(body: Json): Reply {
    const row = this.orders.find(item => item.id === body.id)
    if (!row) return { status: 200, body: { status: 'ERROR', errorMessage: 'order not found' } }
    row.activationPrice = body.priceOrder
    row.stopLoss = body.slPrice
    row.takeProfit = body.tpPrice
    return this.ok()
  }

  private cancelPending(body: Json): Reply {
    this.orders = this.orders.filter(item => item.id !== body.id)
    return this.ok()
  }

  private closePosition(body: Json, partial: boolean): Reply {
    const row = this.positions.find(item => item.id === body.positionId)
    if (!row) return { status: 200, body: { status: 'ERROR', errorMessage: 'position not found' } }
    const volume = partial ? Number(body.volume) : row.volume
    const closingOrderID = this.newId()
    this.closed.push({
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      volume,
      openPrice: row.openPrice,
      closePrice: 1.105,
      openTime: row.openTime,
      time: zoneless(NOW + 1000 * (this.closed.length + 1)),
      profit: partial ? 2 : 3,
      swap: -0.1,
      commission: -0.7,
      closingOrderID,
    })
    if (partial && volume < row.volume) row.volume = Number((row.volume - volume).toFixed(8))
    else this.positions = this.positions.filter(item => item !== row)
    return this.ok(closingOrderID)
  }
}

class MemoryTags implements MatchtraderTagStore {
  map = new Map<string, TagEntry>()
  puts: string[] = []
  async load(): Promise<Map<string, TagEntry>> {
    return new Map(this.map)
  }
  async put(_brokerAccountId: string, orderId: string, entry: TagEntry): Promise<void> {
    this.puts.push(orderId)
    this.map.set(tagKey(orderId), entry)
  }
}

let fake: FakeMatchTrader
let tags: MemoryTags
let clock: number

function provider(overrides: Partial<MatchtraderProviderOptions> = {}): MatchtraderProvider {
  return new MatchtraderProvider({
    loadCredentials: async () => CREDENTIAL,
    tagStore: tags,
    fetchImpl: fake.fetchImpl,
    now: () => clock,
    sleep: async () => {},
    clientOptions: { resolveHost: async () => ['203.0.113.10'] },
    ...overrides,
  })
}

beforeEach(() => {
  fake = new FakeMatchTrader()
  tags = new MemoryTags()
  clock = NOW
  resetMatchtraderLoginGateForTests()
})

test('logs in once, sends the trading headers and cookie, and maps open positions', async () => {
  const mt = provider()
  fake.positions.push({ id: 'W700', symbol: 'EURUSD', side: 'BUY', volume: 0.5, openPrice: 1.09, stopLoss: 1.08, takeProfit: 1.12, openTime: zoneless(NOW - 5000) })
  const open = await mt.openedOrders('fp-1') as Json[]
  assert.equal(fake.logins, 1)
  assert.equal(open.length, 1)
  assert.equal(open[0]!.ticket, 700)
  assert.equal(open[0]!.symbol, 'EURUSD')
  assert.equal(open[0]!.operation, 'Buy')
  assert.equal(open[0]!.lots, 0.5)
  assert.equal(open[0]!.openPrice, 1.09)
  assert.equal(open[0]!.stopLoss, 1.08)
  assert.equal(open[0]!.takeProfit, 1.12)
  assert.equal(open[0]!.comment, '')
  assert.equal(open[0]!.openTime, new Date(NOW - 5000).toISOString())

  const login = fake.callsTo('POST', '/manager/mtr-login')[0]!
  assert.deepEqual(login.body, { email: 'trader@example.com', password: 'pw', brokerId: '42' })
  assert.equal(login.headers.Cookie, undefined)
  for (const call of fake.calls.filter(item => item.path.startsWith('/open-') || item.path.startsWith('/active-'))) {
    assert.equal(call.headers['Auth-trading-api'], API, call.path)
    assert.match(call.headers.Cookie ?? '', /co-auth=tok-1/, call.path)
  }
  await mt.openedOrders('fp-1')
  assert.equal(fake.logins, 1)
})

test('a market order sends lots, side, SL and TP on the broker symbol and returns the position ticket', async () => {
  const mt = provider()
  const result = await mt.orderSend('fp-1', { symbol: 'XAUUSD', operation: 'Sell', volume: 0.237, stoploss: 2010.123456, takeprofit: 1990, comment: COMMENT })
  const posts = fake.callsTo('POST', '/position/open')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0]!.body, {
    instrument: 'XAUUSD.x',
    orderSide: 'SELL',
    volume: 0.23,
    slPrice: 2010.12,
    tpPrice: 1990,
    isMobile: false,
  })
  assert.equal(result.ticket, 9000)
  assert.equal(result.positionTicket, 9000)
  assert.equal(result.symbol, 'XAUUSD.x')
  assert.equal(result.lots, 0.23)
  assert.equal(result.stopLoss, 2010.12)
  assert.equal(result.takeProfit, 1990)

  await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 })
  const bare = fake.callsTo('POST', '/position/open')[1]!.body!
  assert.equal(bare.slPrice, 0)
  assert.equal(bare.tpPrice, 0)
})

test('a size below the instrument minimum or an unknown symbol is refused before anything is sent', async () => {
  const mt = provider()
  await assert.rejects(mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.004 }), /at least 0\.01/)
  await assert.rejects(mt.orderSend('fp-1', { symbol: 'NOPE', operation: 'Buy', volume: 0.1 }), /not on this MatchTrader account/)
  assert.equal(fake.callsTo('POST', '/position/open').length, 0)
})

test('a rejected write surfaces the broker message and does not block a later attempt', async () => {
  const mt = provider()
  fake.rejectWrite = 'Market is closed'
  await assert.rejects(mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 }), /Market is closed/)
  assert.equal(fake.positions.length, 0)
  fake.rejectWrite = null
  const result = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 })
  assert.equal(fake.callsTo('POST', '/position/open').length, 2)
  assert.equal(result.positionTicket, 9000)
})

test('a position whose id differs from the order id is still found, and keeps its comment', async () => {
  const mt = provider()
  fake.positionIdsDiffer = true
  const result = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  assert.equal(result.positionTicket, 9001)
  assert.equal(result.orderTicket, 9000)
  const open = await mt.openedOrders('fp-1') as Json[]
  assert.equal(open[0]!.ticket, 9001)
  assert.equal(open[0]!.comment, COMMENT)
})

test('the signal comment is kept per order id, saved to the store, and recovered by a fresh provider', async () => {
  const mt = provider()
  await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(tags.puts.includes('W9000'))
  assert.equal(tags.map.get('9000')?.comment, COMMENT)
  const open = await mt.openedOrders('fp-1') as Json[]
  assert.equal(open[0]!.comment, COMMENT)

  const fresh = provider()
  const again = await fresh.openedOrders('fp-1') as Json[]
  assert.equal(again[0]!.comment, COMMENT)
})

test('a comment saved under another id is matched by symbol, side and open time, and never to a different symbol', async () => {
  tags.map.set('4999', { comment: COMMENT, symbol: 'EURUSD', side: 'buy', at: NOW - 1000 })
  fake.positions.push(
    { id: 'W5000', symbol: 'EURUSD', side: 'BUY', volume: 0.1, openPrice: 1.1, openTime: zoneless(NOW) },
    { id: 'W5001', symbol: 'XAUUSD.x', side: 'BUY', volume: 0.1, openPrice: 2000, openTime: zoneless(NOW) },
  )
  const open = await provider().openedOrders('fp-1') as Json[]
  assert.equal(open.find(row => row.ticket === 5000)!.comment, COMMENT)
  assert.equal(open.find(row => row.ticket === 5001)!.comment, '')
})

test('pending orders carry type and price, then modify and cancel by id', async () => {
  const mt = provider()
  const placed = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'BuyLimit', volume: 0.1, price: 1.09, stoploss: 1.08, comment: COMMENT })
  assert.deepEqual(fake.callsTo('POST', '/pending-order/create')[0]!.body, {
    instrument: 'EURUSD',
    orderSide: 'BUY',
    volume: 0.1,
    price: 1.09,
    type: 'LIMIT',
    slPrice: 1.08,
    tpPrice: 0,
    isMobile: false,
  })
  assert.equal(placed.ticket, 9000)
  assert.equal(placed.state, 'Placed')

  const open = await mt.openedOrders('fp-1') as Json[]
  assert.equal(open.length, 1)
  assert.equal(open[0]!.operation, 'BuyLimit')
  assert.equal(open[0]!.openPrice, 1.09)
  assert.equal(open[0]!.stopLoss, 1.08)
  assert.equal(open[0]!.comment, COMMENT)

  await mt.orderModify('fp-1', { ticket: placed.ticket, price: 1.085, takeprofit: 1.12 })
  assert.deepEqual(fake.callsTo('POST', '/pending-order/edit')[0]!.body, {
    instrument: 'EURUSD',
    id: 'W9000',
    orderSide: 'BUY',
    type: 'LIMIT',
    volume: 0.1,
    slPrice: 1.08,
    tpPrice: 1.12,
    priceOrder: 1.085,
    isMobile: false,
  })

  const closed = await mt.orderClose('fp-1', { ticket: placed.ticket })
  assert.equal(closed.state, 'position_closed')
  assert.equal(fake.callsTo('POST', '/pending-order/cancel')[0]!.body!.id, 'W9000')
  assert.equal(fake.orders.length, 0)
})

test('editing a position sends both prices, keeping the side that is not being changed', async () => {
  const mt = provider()
  const opened = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Sell', volume: 0.1, stoploss: 1.12, takeprofit: 1.08 })

  await mt.orderModify('fp-1', { ticket: opened.ticket, stoploss: 0, takeprofit: 1.07 })
  assert.deepEqual(fake.callsTo('POST', '/position/edit')[0]!.body, {
    instrument: 'EURUSD',
    id: 'W9000',
    orderSide: 'SELL',
    volume: 0.1,
    slPrice: 0,
    tpPrice: 1.07,
    isMobile: false,
  })

  await mt.orderModify('fp-1', { ticket: opened.ticket, stoploss: 1.13 })
  const second = fake.callsTo('POST', '/position/edit')[1]!.body!
  assert.equal(second.slPrice, 1.13)
  assert.equal(second.tpPrice, 1.07)

  await mt.orderModify('fp-1', { ticket: opened.ticket })
  assert.equal(fake.callsTo('POST', '/position/edit').length, 2)
})

test('a partial close and a full close use their own routes and report the closed trade', async () => {
  const mt = provider()
  const opened = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 })

  const partial = await mt.orderClose('fp-1', { ticket: opened.ticket, lots: 0.04 })
  assert.deepEqual(fake.callsTo('POST', '/position/close-partially')[0]!.body, {
    positionId: 'W9000',
    volume: 0.04,
    isMobile: false,
    instrument: 'EURUSD',
    orderSide: 'BUY',
  })
  assert.equal(partial.lots, 0.04)
  assert.equal(partial.closePrice, 1.105)
  assert.equal(partial.profit, 2)
  assert.equal(partial.swap, -0.1)
  assert.equal(partial.commission, -0.7)
  assert.equal(fake.positions[0]!.volume, 0.06)

  const full = await mt.orderClose('fp-1', { ticket: opened.ticket })
  assert.deepEqual(fake.callsTo('POST', '/position/close')[0]!.body, {
    positionId: 'W9000',
    instrument: 'EURUSD',
    orderSide: 'BUY',
    volume: '0.06',
  })
  assert.equal(full.lots, 0.06)
  assert.equal(full.profit, 3)
  assert.equal(fake.positions.length, 0)
})

test('a close whose answer was lost is read back instead of sent again', async () => {
  const mt = provider()
  const opened = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 })
  fake.dropAfter.set('/position/close', 1)
  const result = await mt.orderClose('fp-1', { ticket: opened.ticket })
  assert.equal(fake.callsTo('POST', '/position/close').length, 1)
  assert.equal(fake.positions.length, 0)
  assert.equal(result.state, 'position_closed')

  const other = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Sell', volume: 0.1 })
  fake.dropBefore.set('/position/close', 1)
  await assert.rejects(mt.orderClose('fp-1', { ticket: other.ticket }), /Could not reach/)
  assert.equal(fake.positions.length, 1)
})

test('an order whose answer was lost is found by its new position and never sent twice', async () => {
  const mt = provider()
  fake.dropAfter.set('/position/open', 1)
  const result = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  assert.equal(fake.callsTo('POST', '/position/open').length, 1)
  assert.equal(fake.positions.length, 1)
  assert.equal(result.positionTicket, 9000)
  const open = await mt.openedOrders('fp-1') as Json[]
  assert.equal(open[0]!.comment, COMMENT)
})

test('an order that never arrived is reported as unconfirmed, and a repeat is then sent once', async () => {
  const mt = provider()
  fake.dropBefore.set('/position/open', 1)
  await assert.rejects(mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT }), /did not confirm/)
  assert.equal(fake.positions.length, 0)
  const result = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  assert.equal(fake.positions.length, 1)
  assert.equal(result.positionTicket, 9000)
})

test('a repeat of an order that did land returns it instead of opening a second position', async () => {
  const mt = provider()
  fake.dropAfter.set('/position/open', 1)
  fake.failReadsAfterDrop = 1
  await assert.rejects(mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT }), /did not confirm/)
  assert.equal(fake.positions.length, 1)
  const again = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1, comment: COMMENT })
  assert.equal(fake.callsTo('POST', '/position/open').length, 1)
  assert.equal(fake.positions.length, 1)
  assert.equal(again.positionTicket, 9000)
})

test('an uncertain pending order is looked up by symbol, side, type and size', async () => {
  const mt = provider()
  fake.dropAfter.set('/pending-order/create', 1)
  const result = await mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'SellStop', volume: 0.1, price: 1.08 })
  assert.equal(fake.callsTo('POST', '/pending-order/create').length, 1)
  assert.equal(fake.orders.length, 1)
  assert.equal(result.ticket, 9000)
  assert.equal(result.state, 'Placed')
})

test('orders on one account are written one at a time', async () => {
  const mt = provider()
  await Promise.all([
    mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 }),
    mt.orderSend('fp-1', { symbol: 'XAUUSD', operation: 'Sell', volume: 0.1 }),
    mt.orderSend('fp-1', { symbol: 'EURUSD', operation: 'Sell', volume: 0.2 }),
  ])
  assert.equal(fake.maxInflight, 1)
  assert.equal(fake.positions.length, 3)
})

test('a 401 triggers one re-login and the request is retried', async () => {
  const mt = provider()
  await mt.openedOrders('fp-1')
  assert.equal(fake.logins, 1)
  fake.expireToken = true
  await mt.openedOrders('fp-1')
  assert.equal(fake.logins, 2)
})

test('when the login token is not accepted, the account token is tried before giving up', async () => {
  const mt = provider()
  fake.acceptAltOnly = true
  await mt.openedOrders('fp-1')
  assert.equal(fake.logins, 2)
  const last = fake.calls[fake.calls.length - 1]!
  assert.equal(last.path, '/active-orders')
  assert.match(last.headers.Cookie ?? '', /co-auth=acctok/)
})

test('a session near its end is refreshed from its cookies instead of logging in again', async () => {
  const mt = provider()
  await mt.openedOrders('fp-1')
  clock = NOW + 14 * 60_000
  await mt.openedOrders('fp-1')
  assert.equal(fake.refreshes, 1)
  assert.equal(fake.logins, 1)
  const last = fake.calls[fake.calls.length - 1]!
  assert.match(last.headers.Cookie ?? '', /co-auth=tok-r1/)
})

test('a rate-limited read is retried once', async () => {
  const mt = provider()
  await mt.openedOrders('fp-1')
  fake.rateLimitOnce = true
  const open = await mt.openedOrders('fp-1')
  assert.deepEqual(open, [])
})

test('account summary, status and trading readiness come from the balance endpoint', async () => {
  const mt = provider()
  const summary = await mt.accountSummary('fp-1')
  assert.equal(summary.balance, 1000)
  assert.equal(summary.equity, 1010)
  assert.equal(summary.profit, 10)
  assert.equal(summary.margin, 20)
  assert.equal(summary.freeMargin, 990)
  assert.equal(summary.currency, 'USD')
  assert.equal(summary.synced, true)
  const status = await mt.mtStatus('fp-1')
  assert.equal(status.account?.tradeAllowed, true)
  assert.equal(status.broker?.server, 'trade.broker.com')
  assert.equal(await mt.verifyTradingReady('fp-1'), true)
  assert.equal((await mt.getV1Account('fp-1')).status, 'connected')
})

test('quote and symbol parameters come from quotations and effective instruments', async () => {
  const mt = provider()
  assert.deepEqual(await mt.quote('fp-1', 'EURUSD'), { symbol: 'EURUSD', bid: 1.1, ask: 1.1002 })
  assert.equal(fake.callsTo('GET', '/quotations')[0]!.query.get('symbols'), 'EURUSD')

  const params = await mt.symbolParams('fp-1', 'XAUUSD')
  assert.equal(params.symbolName, 'XAUUSD.x')
  assert.equal(params.symbol?.digits, 2)
  assert.equal(params.symbol?.contractSize, 100)
  assert.deepEqual(params.groupParams, { minLot: 0.01, maxLot: 20, lotStep: 0.01 })
  assert.deepEqual(await mt.symbols('fp-1'), ['EURUSD', 'XAUUSD.x'])
})

test('closed trades keep partial closes as separate rows, with money, close ticket and comment', async () => {
  const mt = provider()
  tags.map.set('700', { comment: COMMENT, symbol: 'EURUSD', side: 'sell', at: NOW - 60_000 })
  fake.closed.push(
    { id: 'W700', symbol: 'EURUSD', side: 'SELL', volume: 0.04, openPrice: 1.09, closePrice: 1.085, openTime: zoneless(NOW - 60_000), time: zoneless(NOW - 30_000), profit: 20, swap: -1, commission: -0.4, closingOrderID: 'W801', stopLoss: 1.1, takeProfit: 1.08 },
    { id: 'W700', symbol: 'EURUSD', side: 'SELL', volume: 0.06, openPrice: 1.09, closePrice: 1.084, openTime: zoneless(NOW - 60_000), time: zoneless(NOW - 1000), profit: 30, swap: -1.5, commission: -0.6, closingOrderID: 'W802', stopLoss: 1.1, takeProfit: 1.08 },
  )
  const rows = await mt.orderHistory('fp-1', new Date(NOW - 86_400_000).toISOString(), new Date(NOW).toISOString()) as Json[]
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.ticket), [700, 700])
  assert.deepEqual(rows.map(row => row.dealTicket), [801, 802])
  assert.deepEqual(rows.map(row => row.lots), [0.04, 0.06])
  assert.equal(rows[0]!.operation, 'Sell')
  assert.equal(rows[0]!.profit, 20)
  assert.equal(rows[0]!.swap, -1)
  assert.equal(rows[0]!.commission, -0.4)
  assert.equal(rows[0]!.comment, COMMENT)
  assert.equal(rows[0]!.openTime, new Date(NOW - 60_000).toISOString())
  assert.equal(rows[1]!.closeTime, new Date(NOW - 1000).toISOString())
  assert.equal(rows[1]!.closePrice, 1.084)

  const body = fake.callsTo('POST', '/closed-positions')[0]!.body!
  assert.equal(body.from, new Date(NOW - 86_400_000).toISOString())
  assert.equal(body.to, new Date(NOW).toISOString())

  assert.equal((await mt.closedOrders('fp-1')).length, 2)
  const page = await mt.orderHistoryPage('fp-1', new Date(NOW - 86_400_000).toISOString(), new Date(NOW).toISOString())
  assert.equal(page.pagesCount, 1)
  assert.equal(page.orders.length, 2)
})

test('bad credentials fail the session check without leaking the password', async () => {
  fake.password = 'different'
  const mt = provider()
  await assert.rejects(mt.ensureConnected('fp-1'), error => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /pw/)
    return true
  })
  assert.equal(await mt.keepSessionAliveDetailed('fp-1'), 'token_reconnect_failed')
  const account = await mt.getV1Account('fp-1')
  assert.equal(account.status, 'error')
})

test('a login with two-factor sign-in is refused with a clear reason', async () => {
  fake.tfa = true
  const mt = provider()
  await assert.rejects(mt.ensureConnected('fp-1'), /two-factor/i)
  assert.equal(await mt.keepSessionAliveDetailed('fp-1'), 'token_reconnect_failed')
})

test('a platform host that resolves to a private address is never contacted', async () => {
  const mt = provider({ clientOptions: { resolveHost: async () => ['10.0.0.8'] } })
  await assert.rejects(mt.ensureConnected('fp-1'), /private address/)
  assert.equal(fake.calls.length, 0)
  const missing = provider({ clientOptions: { resolveHost: async () => { throw new Error('ENOTFOUND') } } })
  await assert.rejects(missing.ensureConnected('fp-1'), /Could not find/)
  assert.equal(fake.calls.length, 0)
})

test('a stored platform URL that is not a plain https host is refused', async () => {
  for (const serverUrl of ['http://trade.broker.com', 'https://127.0.0.1', 'https://user:pw@trade.broker.com', 'https://trade.broker.com:8443', 'https://db.internal']) {
    const mt = provider({ loadCredentials: async () => ({ ...CREDENTIAL, serverUrl }) })
    await assert.rejects(mt.ensureConnected('fp-1'), /https|IP address|username|port|public/i, serverUrl)
  }
  assert.equal(fake.calls.length, 0)
})

test('a redirect from the platform is not followed', async () => {
  const mt = provider({ fetchImpl: (async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })) as typeof fetch })
  await assert.rejects(mt.ensureConnected('fp-1'), /redirected/)
})

test('an account without stored credentials is not configured', async () => {
  const mt = provider({ loadCredentials: async () => null })
  await assert.rejects(mt.openedOrders('missing'), /not configured/)
  assert.equal(await mt.keepSessionAliveDetailed('missing'), 'token_reconnect_failed')
})

test('keepSessionAlive reports alive for a working login and the provider cannot connect with a password', async () => {
  const mt = provider()
  assert.equal(await mt.keepSessionAlive('fp-1'), true)
  await assert.rejects(mt.connectEx(), /stored login/)
})

test('unknown tickets are reported clearly', async () => {
  const mt = provider()
  await assert.rejects(mt.orderClose('fp-1', { ticket: 424242 }), /unknown ticket 424242/)
  await assert.rejects(mt.orderModify('fp-1', { ticket: 424242, stoploss: 1 }), /unknown ticket 424242/)
})
