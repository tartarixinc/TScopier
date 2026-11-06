import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { installRelayFetch } from './relayFetch'

const nativeFetch = globalThis.fetch
const SAVED: Record<string, string | undefined> = {
  SUPABASE_RELAY_TOKEN: process.env.SUPABASE_RELAY_TOKEN,
  SUPABASE_URL: process.env.SUPABASE_URL,
}

interface Call {
  url: string
  headerToken: string | null
  originalAuth: string | null
}

function recordFetch(): { calls: Call[] } {
  const calls: Call[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers)
    calls.push({
      url,
      headerToken: headers?.get('x-relay-token') ?? null,
      originalAuth: headers?.get('apikey') ?? null,
    })
    return new Response('{}')
  }) as typeof fetch
  return { calls }
}

afterEach(() => {
  globalThis.fetch = nativeFetch
  if (SAVED.SUPABASE_RELAY_TOKEN === undefined) delete process.env.SUPABASE_RELAY_TOKEN
  else process.env.SUPABASE_RELAY_TOKEN = SAVED.SUPABASE_RELAY_TOKEN
  if (SAVED.SUPABASE_URL === undefined) delete process.env.SUPABASE_URL
  else process.env.SUPABASE_URL = SAVED.SUPABASE_URL
})

test('adds x-relay-token to requests targeting SUPABASE_URL and leaves other hosts alone', async () => {
  process.env.SUPABASE_URL = 'https://supa-gw.tscopier.ai'
  process.env.SUPABASE_RELAY_TOKEN = 'relay-secret'
  const { calls } = recordFetch()
  installRelayFetch()

  await fetch('https://supa-gw.tscopier.ai/rest/v1/broker_accounts?select=id', {
    method: 'POST',
    headers: { apikey: 'service-jwt', 'Content-Type': 'application/json' },
    body: '{}',
  })
  await fetch('https://example.com/health')

  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.headerToken, 'relay-secret')
  assert.equal(calls[0]!.originalAuth, 'service-jwt')
  assert.equal(calls[1]!.headerToken, null)
})

test('covers Request-object inputs and preserves their original headers', async () => {
  process.env.SUPABASE_URL = 'https://supa-gw.tscopier.ai'
  process.env.SUPABASE_RELAY_TOKEN = 'relay-secret'
  const { calls } = recordFetch()
  installRelayFetch()

  await fetch(new Request('https://supa-gw.tscopier.ai/functions/v1/parse-signal', {
    method: 'POST',
    headers: { Authorization: 'Bearer jwt' },
  }))

  assert.equal(calls[0]!.headerToken, 'relay-secret')
  assert.equal(calls[0]!.originalAuth, null)
  assert.equal(calls[0]!.url, 'https://supa-gw.tscopier.ai/functions/v1/parse-signal')
})

test('is a no-op without token or base URL (direct mode unchanged)', async () => {
  process.env.SUPABASE_URL = 'https://sso.tscopier.ai'
  delete process.env.SUPABASE_RELAY_TOKEN
  const { calls } = recordFetch()
  installRelayFetch()

  await fetch('https://sso.tscopier.ai/rest/v1/x')

  assert.equal(calls[0]!.headerToken, null)
})
