import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, test } from 'node:test'
import { MtapiApiError, MtapiProvider } from './mtapiProvider'
import { fetchLiveAccountEquity } from './copyLimitMetrics'
import {
  resetProviderResolverForTests,
  setMtapiProviderForResolverTests,
} from './providerResolver'

const oldBase = process.env.MTAPI_BASE_URL
const oldInternalToken = process.env.MTAPI_INTERNAL_TOKEN

beforeEach(() => {
  process.env.MTAPI_BASE_URL = 'https://mtapi.test'
})

afterEach(() => {
  resetProviderResolverForTests()
  if (oldBase == null) delete process.env.MTAPI_BASE_URL
  else process.env.MTAPI_BASE_URL = oldBase
  if (oldInternalToken == null) delete process.env.MTAPI_INTERNAL_TOKEN
  else process.env.MTAPI_INTERNAL_TOKEN = oldInternalToken
})

test('synced=false account equity is not authoritative to copy-limit consumers', async () => {
  const api = provider(url => {
    if (url.pathname === '/AccountSummary') {
      return new Response(JSON.stringify({ equity: 999, synced: false }))
    }
    if (url.pathname === '/OpenedOrders') {
      return new Response(JSON.stringify([{ ticket: 1, profit: 10 }]))
    }
    return new Response('{}', { status: 404 })
  })
  setMtapiProviderForResolverTests(api)
  assert.equal(await fetchLiveAccountEquity('session', 'MT5', 80, {
    provider: 'mtapi',
    lastBalance: 100,
  }), 110)
})

function provider(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): MtapiProvider {
  return new MtapiProvider({
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input)
      return Promise.resolve(handler(new URL(raw), init))
    }) as typeof fetch,
    timeoutMs: 2_000,
  })
}

test('OpenedOrders accepts a successful authoritative empty list', async () => {
  const api = provider(() => new Response('[]', { status: 200 }))
  assert.deepEqual(await api.openedOrders('session'), [])
})

test('X-Internal-Token header is sent when MTAPI_INTERNAL_TOKEN is set', async () => {
  process.env.MTAPI_INTERNAL_TOKEN = 'internal-secret'
  let token: string | undefined
  const api = new MtapiProvider({
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      token = headers['X-Internal-Token']
      return new Response('[]')
    }) as typeof fetch,
    timeoutMs: 2_000,
  })
  assert.deepEqual(await api.openedOrders('session'), [])
  assert.equal(token, 'internal-secret')
})

test('X-Internal-Token header is omitted when MTAPI_INTERNAL_TOKEN is unset', async () => {
  delete process.env.MTAPI_INTERNAL_TOKEN
  let hasToken = false
  const api = new MtapiProvider({
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      hasToken = 'X-Internal-Token' in headers
      return new Response('[]')
    }) as typeof fetch,
    timeoutMs: 2_000,
  })
  assert.deepEqual(await api.openedOrders('session'), [])
  assert.equal(hasToken, false)
})

test('X-Internal-Token header is omitted for whitespace-only MTAPI_INTERNAL_TOKEN', async () => {
  process.env.MTAPI_INTERNAL_TOKEN = '   '
  let hasToken = false
  const api = new MtapiProvider({
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      hasToken = 'X-Internal-Token' in headers
      return new Response('[]')
    }) as typeof fetch,
    timeoutMs: 2_000,
  })
  assert.deepEqual(await api.openedOrders('session'), [])
  assert.equal(hasToken, false)
})

test('OpenedOrders failure and malformed success never become authoritative empty lists', async () => {
  const failed = provider(() => new Response(
    JSON.stringify({ code: 'INVALID_TOKEN', message: 'gone' }),
    { status: 201 },
  ))
  await assert.rejects(() => failed.openedOrders('session'), /gone/)

  const malformed = provider(() => new Response('{}', { status: 200 }))
  await assert.rejects(
    () => malformed.openedOrders('session'),
    (error: unknown) => error instanceof MtapiApiError && error.code === 'INVALID_RESPONSE',
  )
})

test('AccountSummary preserves synced=false and normalizes values', async () => {
  const api = provider(() => new Response(JSON.stringify({
    balance: 5000, equity: 0, currency: 'USD', synced: false,
  })))
  assert.deepEqual(await api.accountSummary('session'), {
    balance: 5000,
    credit: undefined,
    profit: undefined,
    equity: 0,
    margin: undefined,
    freeMargin: undefined,
    marginLevel: undefined,
    leverage: undefined,
    currency: 'USD',
    type: undefined,
    synced: false,
  })
  assert.equal(await api.verifyTradingReady('session'), false)
})

test('AccountSummary maps string and numeric trade modes to AccountSummary.type', async () => {
  const make = (type: unknown) => provider(() => new Response(JSON.stringify({
    balance: 100, equity: 100, type, synced: true,
  })))
  assert.equal((await make('demo').accountSummary('s')).type, 0)
  assert.equal((await make('Demo').accountSummary('s')).type, 0)
  assert.equal((await make('contest').accountSummary('s')).type, 1)
  assert.equal((await make('real').accountSummary('s')).type, 2)
  assert.equal((await make('live').accountSummary('s')).type, 2)
  assert.equal((await make(0).accountSummary('s')).type, 0)
  assert.equal((await make(2).accountSummary('s')).type, 2)
  assert.equal((await make('nonsense').accountSummary('s')).type, undefined)
  assert.equal((await make(undefined).accountSummary('s')).type, undefined)
})

test('quote, symbols, SymbolParams, status, and history reads normalize MTAPI shapes', async () => {
  const api = provider(url => {
    switch (url.pathname) {
      case '/GetQuote':
        return new Response(JSON.stringify({ symbol: 'EURUSDm', bid: 1.1, ask: 1.2, time: 'now' }))
      case '/Symbols':
        return new Response(JSON.stringify({ EURUSDm: { digits: 5 } }))
      case '/SymbolParams':
        return new Response(JSON.stringify({
          symbol: 'EURUSDm',
          symbolInfo: { digits: 5, points: 0.00001, contractSize: 100000 },
          symbolGroup: { minLots: 0.01, maxLots: 200, lotsStep: 0.01 },
        }))
      case '/ConnectionStatus':
        return new Response(JSON.stringify({ isConnected: true, lastQuoteTimeUTC: 'now' }))
      case '/OrderHistory':
        return new Response(JSON.stringify({ orders: [{ ticket: 9 }] }))
      case '/ClosedOrders':
        return new Response(JSON.stringify([{ ticket: 8 }]))
      case '/HistoryPositions':
        return new Response(JSON.stringify({ positions: [{ ticket: 7 }] }))
      default:
        return new Response('{}', { status: 404 })
    }
  })
  assert.deepEqual(await api.quote('session', 'EURUSDm'), {
    symbol: 'EURUSDm', bid: 1.1, ask: 1.2, time: 'now',
  })
  assert.deepEqual(await api.symbols('session'), [{ symbol: 'EURUSDm', digits: 5 }])
  const spec = await api.symbolParams('session', 'EURUSDm')
  assert.equal(spec.symbol?.point, 0.00001)
  assert.equal(spec.groupParams?.lotStep, 0.01)
  assert.equal((await api.mtStatus('session')).broker?.connected, true)
  assert.deepEqual(await api.orderHistory('session', 'from', 'to'), [{ ticket: 9 }])
  assert.deepEqual(await api.closedOrders('session'), [{ ticket: 8 }])
  assert.deepEqual(await api.historyPositions('session', 'from', 'to'), [{ ticket: 7 }])
})

test('ConnectEx and ConnectByToken use GET query parameters without leaking credentials in errors', async () => {
  const calls: URL[] = []
  const api = provider(url => {
    calls.push(url)
    if (url.pathname === '/ConnectEx') return new Response('token-1')
    if (url.pathname === '/ConnectByToken') return new Response('token-1')
    return new Response('OK')
  })
  assert.equal(await api.connectEx({
    id: 'broker', server: 'Server', login: '123', password: 'top-secret', platform: 'MT5',
  }), 'token-1')
  await api.connectByToken('token-1')
  assert.equal(calls[0]?.searchParams.get('password'), 'top-secret')

  const broken = provider(() => { throw new Error('top-secret') })
  await assert.rejects(
    () => broken.connectEx({
      id: 'broker', server: 'Server', login: '123', password: 'top-secret', platform: 'MT5',
    }),
    (error: unknown) => error instanceof Error && !error.message.includes('top-secret'),
  )
})

test('ensureConnected is token-first and uses credential recovery only for an invalid token', async () => {
  const endpoints: string[] = []
  const api = provider(url => {
    endpoints.push(url.pathname)
    return new Response(JSON.stringify({ code: 'INVALID_TOKEN', message: 'gone' }), { status: 201 })
  })
  let recovered = 0
  api.setRecoveryHandler(async () => {
    recovered += 1
    return 'new-token'
  })
  await api.ensureConnected('old-token')
  assert.deepEqual(endpoints, ['/CheckConnect', '/ConnectByToken'])
  assert.equal(recovered, 1)
})

test('read retries once after INVALID_TOKEN encoded in the MTAPI error field', async () => {
  const endpoints: string[] = []
  let openedCalls = 0
  const api = provider(url => {
    endpoints.push(url.pathname)
    if (url.pathname === '/OpenedOrders') {
      openedCalls += 1
      if (openedCalls === 1) {
        return new Response(JSON.stringify({ error: 'INVALID_TOKEN', message: 'gone' }), {
          status: 201,
        })
      }
      return new Response('[]')
    }
    if (url.pathname === '/CheckConnect') {
      return new Response(JSON.stringify({ error: 'INVALID_TOKEN' }), { status: 201 })
    }
    if (url.pathname === '/ConnectByToken') return new Response('session')
    return new Response('{}', { status: 404 })
  })
  assert.deepEqual(await api.openedOrders('session'), [])
  assert.deepEqual(endpoints, [
    '/OpenedOrders', '/CheckConnect', '/ConnectByToken', '/OpenedOrders',
  ])
})

test('orderSend calls OrderSendSafe on MT5 and normalizes the response', async () => {
  let capturedUrl: URL | undefined
  const api = provider(url => {
    capturedUrl = url
    return new Response(JSON.stringify({
      ticket: 3223311401, openPrice: 1.1548, lots: 0.01, state: 'Filled',
      symbol: 'EURUSDm', stopLoss: 0, takeProfit: 0,
    }))
  })
  const result = await api.orderSend('session', {
    symbol: 'EURUSDm', operation: 'Buy', volume: 0.01,
    stoploss: 1.15, takeprofit: 1.16,
  })
  assert.equal(result.ticket, 3223311401)
  assert.equal(result.state, 'Filled')
  assert.equal(capturedUrl?.pathname, '/OrderSendSafe')
  assert.equal(capturedUrl?.searchParams.get('symbol'), 'EURUSDm')
  assert.equal(capturedUrl?.searchParams.get('operation'), 'Buy')
  assert.equal(capturedUrl?.searchParams.get('volume'), '0.01')
  assert.equal(capturedUrl?.searchParams.get('stoploss'), '1.15')
  assert.equal(capturedUrl?.searchParams.get('takeprofit'), '1.16')
})

test('orderModify calls OrderModifySafe on MT5 and normalizes the response', async () => {
  let capturedUrl: URL | undefined
  const api = provider(url => {
    capturedUrl = url
    return new Response(JSON.stringify({
      ticket: 3223311401, stopLoss: 1.149, takeProfit: 1.161, state: 'Filled',
    }))
  })
  const result = await api.orderModify('session', {
    ticket: 3223311401, stoploss: 1.149, takeprofit: 1.161,
  })
  assert.equal(result.ticket, 3223311401)
  assert.equal(capturedUrl?.pathname, '/OrderModifySafe')
  assert.equal(capturedUrl?.searchParams.get('ticket'), '3223311401')
  assert.equal(capturedUrl?.searchParams.get('stoploss'), '1.149')
  assert.equal(capturedUrl?.searchParams.get('takeprofit'), '1.161')
})

test('orderClose calls OrderCloseSafe on MT5 and normalizes the response', async () => {
  let capturedUrl: URL | undefined
  const api = provider(url => {
    capturedUrl = url
    return new Response(JSON.stringify({
      ticket: 3223311401, closePrice: 1.1544, closeLots: 0.01,
      state: 'Started', profit: -0.4,
    }))
  })
  const result = await api.orderClose('session', { ticket: 3223311401 })
  assert.equal(result.ticket, 3223311401)
  assert.equal(result.state, 'Started')
  assert.equal(capturedUrl?.pathname, '/OrderCloseSafe')
  assert.equal(capturedUrl?.searchParams.get('ticket'), '3223311401')
})

test('orderClose calls OrderClose on MT4', async () => {
  let capturedUrl: URL | undefined
  const api = provider(url => {
    capturedUrl = url
    return new Response(JSON.stringify({
      ticket: 123, closePrice: 1.15, state: 'Started', profit: 0,
    }))
  })
  api.seedPlatformCache('mt4-session', 'MT4')
  const result = await api.orderClose('mt4-session', { ticket: 123 })
  assert.equal(result.ticket, 123)
  assert.equal(capturedUrl?.pathname, '/OrderClose')
})

test('orderSend retries after INVALID_TOKEN and reconnects', async () => {
  const endpoints: string[] = []
  let sendCalls = 0
  const api = provider(url => {
    endpoints.push(url.pathname)
    if (url.pathname === '/OrderSendSafe') {
      sendCalls += 1
      if (sendCalls === 1) {
        return new Response(JSON.stringify({ error: 'INVALID_TOKEN', message: 'gone' }), {
          status: 201,
        })
      }
      return new Response(JSON.stringify({ ticket: 999, state: 'Filled' }))
    }
    if (url.pathname === '/CheckConnect') {
      return new Response(JSON.stringify({ error: 'INVALID_TOKEN' }), { status: 201 })
    }
    if (url.pathname === '/ConnectByToken') return new Response('session')
    return new Response('{}')
  })
  const result = await api.orderSend('session', {
    symbol: 'EURUSDm', operation: 'Buy', volume: 0.01,
  })
  assert.equal(result.ticket, 999)
  assert.deepEqual(endpoints, [
    '/OrderSendSafe', '/CheckConnect', '/ConnectByToken', '/OrderSendSafe',
  ])
})
