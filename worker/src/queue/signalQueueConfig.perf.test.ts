import { describe, it } from 'node:test'
import { buildIdempotencyKey, resetSignalQueueConfigCache } from '../queue/signalQueueConfig'
import { assertLatencyBudget, benchmarkSync } from '../test/perfBudget'

describe('signalQueueConfig latency', () => {
  it('builds idempotency keys within latency budget', () => {
    resetSignalQueueConfigCache()
    const payload = {
      userId: 'user-abc',
      signalId: 'sig-123',
      actionClass: 'entry',
      brokerAccountId: 'broker-1',
    }

    const samples = benchmarkSync(() => {
      buildIdempotencyKey(payload)
    }, 1500)

    assertLatencyBudget('buildIdempotencyKey', samples, 0.25)
  })
})
