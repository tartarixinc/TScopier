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
    assert.equal(result.confirmed, false)
    assert.equal(result.reconciliationRequired, true)
    assert.equal(openedCalls, 0)
  })

  it('closeWithVerification liveFast still requires broker readback', async () => {
    let openedCalls = 0
    const snapshots = [[{ ticket: 12345, type: 0 }], [{ ticket: 999, type: 0 }]]
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        return snapshots.shift() ?? []
      },
    })
    const result = await closeWithVerification(api, 'uuid', 12345, { liveFast: true })
    assert.equal(result.confirmed, true)
    assert.equal(openedCalls, 2)
  })

  it('closeWithVerification verified polls openedOrders', async () => {
    let openedCalls = 0
    const snapshots = [[{ ticket: 12345, type: 0 }], [{ ticket: 999, type: 0 }]]
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        return snapshots.shift() ?? []
      },
    })
    const result = await closeWithVerification(api, 'uuid', 12345, { liveFast: false })
    assert.equal(result.confirmed, true)
    assert.equal(openedCalls, 2)
  })
})

  it('broker readback failure does not confirm close', async () => {
    let openedCalls = 0
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        if (openedCalls === 1) return [{ ticket: 12345, type: 0 }]
        throw new Error('bridge readback unavailable')
      },
    })
    const result = await closeWithVerification(api, 'uuid', 12345, { liveFast: true })
    assert.equal(result.confirmed, false)
    assert.equal(result.reconciliationRequired, true)
    assert.match(result.reason ?? '', /readback failed/)
  })

  it('ambiguous close verification stays open and requires reconciliation', async () => {
    let openedCalls = 0
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        if (openedCalls === 1) return [{ ticket: 12345, type: 0 }]
        return [
          { ticket: 200, type: 0, orderTicket: 12345 },
          { ticket: 300, type: 0, orderTicket: 12345 },
        ]
      },
    })
    const result = await closeWithVerification(api, 'uuid', 12345, {
      liveFast: true,
      maxAttempts: 1,
    })
    assert.equal(result.confirmed, false)
    assert.equal(result.reconciliationRequired, true)
    assert.match(result.reason ?? '', /reconciliation required/)
  })

  it('an empty post-close snapshot is not proof of closure', async () => {
    let openedCalls = 0
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        return openedCalls === 1 ? [{ ticket: 12345, type: 0 }] : []
      },
    })
    const result = await closeWithVerification(api, 'uuid', 12345, {
      liveFast: true,
      maxAttempts: 1,
    })
    assert.equal(result.confirmed, false)
    assert.equal(result.reconciliationRequired, true)
    assert.match(result.reason ?? '', /empty/)
  })
