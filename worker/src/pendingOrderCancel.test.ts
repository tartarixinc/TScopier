import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cancelPendingOrderAtBroker,
  PendingCancelBackoff,
  type PendingCancelApi,
} from './pendingOrderCancel'

describe('cancelPendingOrderAtBroker', () => {
  it('prefers the provider cancel endpoint when present', async () => {
    const calls: Array<{ endpoint: string; ticket: number; sessionId: string }> = []
    const api: PendingCancelApi = {
      async orderClose(id, args) { calls.push({ endpoint: 'orderClose', ticket: args.ticket, sessionId: id }) },
      async orderCancel(id, args) { calls.push({ endpoint: 'orderCancel', ticket: args.ticket, sessionId: id }) },
    }
    await cancelPendingOrderAtBroker(api, 'session-1', 42)
    assert.deepEqual(calls, [{ endpoint: 'orderCancel', ticket: 42, sessionId: 'session-1' }])
  })

  it('falls back to orderClose when the provider has no cancel endpoint', async () => {
    const calls: Array<{ endpoint: string; ticket: number }> = []
    const api: PendingCancelApi = {
      async orderClose(_id, args) { calls.push({ endpoint: 'orderClose', ticket: args.ticket }) },
    }
    await cancelPendingOrderAtBroker(api, 'session-1', 43)
    assert.deepEqual(calls, [{ endpoint: 'orderClose', ticket: 43 }])
  })

  it('propagates cancel failures to the caller', async () => {
    const api: PendingCancelApi = {
      async orderClose() { /* never reached */ },
      async orderCancel() { throw new Error('Invalid request') },
    }
    await assert.rejects(() => cancelPendingOrderAtBroker(api, 'session-1', 44), /Invalid request/)
  })
})

describe('PendingCancelBackoff', () => {
  const opts = { maxAttempts: 3, backoffMs: 60_000, cycleMs: 5_000 }

  it('spaces the first attempts and escalates exactly once', () => {
    let now = 1_000
    const backoff = new PendingCancelBackoff({ ...opts, now: () => now })

    assert.equal(backoff.shouldAttempt('b|1'), true)
    assert.equal(backoff.recordFailure('b|1'), false)
    assert.equal(backoff.attemptsFor('b|1'), 1)

    // before the cycle spacing elapses: no attempt
    now += 1_000
    assert.equal(backoff.shouldAttempt('b|1'), false)
    // after the cycle spacing: attempt again
    now += 4_100
    assert.equal(backoff.shouldAttempt('b|1'), true)
    assert.equal(backoff.recordFailure('b|1'), false)

    now += 5_100
    assert.equal(backoff.shouldAttempt('b|1'), true)
    // third failure enters backoff and escalates exactly once
    assert.equal(backoff.recordFailure('b|1'), true)
    assert.equal(backoff.attemptsFor('b|1'), 3)
    assert.equal(backoff.shouldAttempt('b|1'), false)

    // inside the backoff window: no attempt is made (the sweep skips the
    // ticket entirely, so recordFailure is never reached while backing off)
    now += 30_000
    assert.equal(backoff.shouldAttempt('b|1'), false)

    // past the backoff window: allowed again; the next failure re-enters the
    // backoff window but does NOT escalate a second time (one report per
    // failure series, until a success clears it)
    now += 40_000
    assert.equal(backoff.shouldAttempt('b|1'), true)
    assert.equal(backoff.recordFailure('b|1'), false)
    assert.equal(backoff.attemptsFor('b|1'), 4)
    assert.equal(backoff.shouldAttempt('b|1'), false)
  })

  it('a successful cancel clears the ticket', () => {
    const backoff = new PendingCancelBackoff({ ...opts, now: () => 0 })
    backoff.recordFailure('b|2')
    backoff.recordFailure('b|2')
    backoff.recordFailure('b|2')
    backoff.recordSuccess('b|2')
    assert.equal(backoff.attemptsFor('b|2'), 0)
    assert.equal(backoff.shouldAttempt('b|2'), true)
    assert.equal(backoff.recordFailure('b|2'), false)
  })

  it('tracks tickets independently', () => {
    const backoff = new PendingCancelBackoff({ ...opts, now: () => 0 })
    backoff.recordFailure('b|3')
    backoff.recordFailure('b|3')
    assert.equal(backoff.shouldAttempt('b|4'), true)
    assert.equal(backoff.attemptsFor('b|4'), 0)
  })
})
