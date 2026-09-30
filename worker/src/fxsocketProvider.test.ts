import test from 'node:test'
import assert from 'node:assert/strict'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { FxsocketProvider } from './fxsocketProvider'

function capturingClient() {
  const calls: unknown[][] = []
  const client = {
    orderHistory: async (...args: unknown[]) => {
      calls.push(args)
      return []
    },
  } as unknown as FxsocketBrokerClient
  return { client, calls }
}

test('orderHistory forwards the optional timeout to the underlying client', async () => {
  const { client, calls } = capturingClient()
  const provider = new FxsocketProvider(client)
  await provider.orderHistory('acc-1', '2026-01-01T00:00:00', '2026-09-25T00:00:00', 90_000)
  assert.deepEqual(calls[0], ['acc-1', '2026-01-01T00:00:00', '2026-09-25T00:00:00', 90_000])
})

test('orderHistory without a timeout stays a three-argument call', async () => {
  const { client, calls } = capturingClient()
  const provider = new FxsocketProvider(client)
  await provider.orderHistory('acc-1', 'a', 'b')
  assert.deepEqual(calls[0], ['acc-1', 'a', 'b'])
  assert.equal(calls[0].length, 3)
})
