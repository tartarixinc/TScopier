import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { closeMarketPositionFast, closeOrderFast, closeWithVerification } from './managementClose'
import type { FxsocketBrokerClient } from './fxsocketClient'

function mockApi(overrides: Partial<FxsocketBrokerClient> = {}): FxsocketBrokerClient {
  return {
    orderClose: async () => ({ state: 'filled' }),
    openedOrders: async () => [],
    ...overrides,
  } as FxsocketBrokerClient
}

describe('managementClose', () => {
  it('closeMarketPositionFast confirms without openedOrders', async () => {
    let openedCalls = 0
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        return [{ ticket: 12345, type: 0 }]
      },
    })
    const result = await closeMarketPositionFast(api, 'uuid', 12345)
    assert.equal(result.confirmed, true)
    assert.equal(result.ticket, 12345)
    assert.equal(openedCalls, 0)
  })

  it('closeMarketPositionFast confirms already-closed / unknown ticket', async () => {
    const api = mockApi({
      orderClose: async () => {
        throw new Error('Unknown ticket 12345')
      },
    })
    const result = await closeMarketPositionFast(api, 'uuid', 12345)
    assert.equal(result.confirmed, true)
    assert.equal(result.ticket, 12345)
  })

  it('closeMarketPositionFast rejects hard close failures', async () => {
    const api = mockApi({
      orderClose: async () => ({ state: 'rejected' }),
    })
    const result = await closeMarketPositionFast(api, 'uuid', 12345)
    assert.equal(result.confirmed, false)
    assert.match(result.reason ?? '', /rejected/)
  })

  it('closeOrderFast aliases trusted-ack confirm', async () => {
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

  it('an authoritative cTrader close confirms when the book is empty', async () => {
    let calls = 0
    const api = mockApi({
      orderClose: async () => ({ ticket: 12345, state: 'position_closed' }),
      openedOrders: async () => {
        calls += 1
        return calls === 1 ? [{ ticket: 12345, type: 0 }] : []
      },
    })
    const result = await closeWithVerification(api, 'uuid', 12345, {
      liveFast: true,
      maxAttempts: 1,
    })
    assert.equal(result.confirmed, true)
    assert.equal(result.reconciliationRequired, undefined)
  })

  it('an empty post-close snapshot confirms closure when it was the only open position', async () => {
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
    assert.equal(result.confirmed, true)
  })

  it('an empty post-close snapshot confirms this ticket even when siblings were open pre-close', async () => {
    let openedCalls = 0
    const api = mockApi({
      openedOrders: async () => {
        openedCalls += 1
        // Multi-leg books often get a flaky empty openedOrders after orderClose.
        // Once retries exhaust, confirm this ticket — siblings reconcile separately.
        return openedCalls === 1
          ? [{ ticket: 12345, type: 0 }, { ticket: 999, type: 0 }]
          : []
      },
    })
    const result = await closeWithVerification(api, 'uuid', 12345, {
      liveFast: true,
      maxAttempts: 1,
    })
    assert.equal(result.confirmed, true)
    assert.equal(result.ticket, 12345)
    assert.ok(openedCalls > 2)
  })
})
