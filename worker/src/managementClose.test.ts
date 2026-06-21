import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { closeOrderFast, closeWithVerification } from './managementClose'
import type { FxsocketBrokerClient } from './fxsocketClient'

function mockApi(overrides: Partial<FxsocketBrokerClient> = {}): FxsocketBrokerClient {
  return {
    orderClose: async () => ({ state: 'filled' }),
    openedOrders: async () => [],
    ...overrides,
  } as FxsocketBrokerClient
}

describe('managementClose', () => {
  it('closeOrderFast skips openedOrders poll', async () => {
    let openedCalls = 0
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        return []
      },
    })
    const result = await closeOrderFast(api, 'uuid', 12345)
    assert.equal(result.confirmed, true)
    assert.equal(openedCalls, 0)
  })

  it('closeWithVerification liveFast skips verify sleep and poll', async () => {
    let openedCalls = 0
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        return [{ ticket: 99 }]
      },
    })
    const result = await closeWithVerification(api, 'uuid', 12345, { liveFast: true })
    assert.equal(result.confirmed, true)
    assert.equal(openedCalls, 0)
  })

  it('closeWithVerification verified polls openedOrders', async () => {
    let openedCalls = 0
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        return []
      },
    })
    const result = await closeWithVerification(api, 'uuid', 12345, { liveFast: false })
    assert.equal(result.confirmed, true)
    assert.equal(openedCalls, 1)
  })
})
