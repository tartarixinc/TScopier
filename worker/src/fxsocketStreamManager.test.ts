import assert from 'node:assert/strict'
import test from 'node:test'
import { FxsocketStreamManager } from './fxsocketStreamManager'

test('FxsocketStreamManager: last unsubscribe does not stack overflow on teardown', () => {
  process.env.FXSOCKET_API_KEY = process.env.FXSOCKET_API_KEY ?? 'test-key'
  const manager = new FxsocketStreamManager({ apiKey: 'test-key' })
  const handler = () => {}
  const unsub = manager.subscribe('acct-1', handler, [{ topic: 'account' }])
  assert.doesNotThrow(() => unsub())
})
