import assert from 'node:assert/strict'
import test from 'node:test'
import { FxsocketClient } from './fxsocketClient.ts'

const env = { get: (key: string) => key === 'FXSOCKET_API_KEY' ? 'test-key' : undefined }

test('strict FXSocket deletion succeeds only on a successful remote response', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(null, { status: 204 })
    await new FxsocketClient(env).deleteAccountStrict('account-1')
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await assert.rejects(() => new FxsocketClient(env).deleteAccountStrict('account-1'))
  } finally {
    globalThis.fetch = originalFetch
  }
})
