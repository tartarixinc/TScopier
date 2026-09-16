import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, test } from 'node:test'
import { MtapiApiError, MtapiProvider } from './mtapiProvider'
import { fetchLiveAccountEquity } from './copyLimitMetrics'
import {
  resetProviderResolverForTests,
  setMtapiProviderForResolverTests,
} from './providerResolver'

const oldBase = process.env.MTAPI_BASE_URL

beforeEach(() => {
  process.env.MTAPI_BASE_URL = 'https://mtapi.test'
})

afterEach(() => {
  resetProviderResolverForTests()
  if (oldBase == null) delete process.env.MTAPI_BASE_URL
  else process.env.MTAPI_BASE_URL = oldBase
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
    synced: false,
  })
  assert.equal(await api.verifyTradingReady('session'), false)
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

test('all MTAPI trading methods fail locally with MTAPI_READ_ONLY', async () => {
  let requests = 0
  const api = provider(() => { requests += 1; return new Response('{}') })
  for (const call of [
    () => api.orderSend('session', { symbol: 'EURUSD', operation: 'Buy', volume: 0.1 }),
    () => api.orderModify('session', { ticket: 1, stoploss: 1 }),
    () => api.orderClose('session', { ticket: 1 }),
  ]) {
    await assert.rejects(
      call,
      (error: unknown) => error instanceof MtapiApiError && error.code === 'MTAPI_READ_ONLY',
    )
  }
  assert.equal(requests, 0)
})
