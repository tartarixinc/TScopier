import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getLiveFeedGeneration,
  getLiveFeedStatus,
  isAuthSessionError,
  reportLiveFeedFailure,
  reportLiveFeedSuccess,
  resetLiveFeedStatus,
  subscribeLiveFeed,
} from './liveFeedStatus'

function now(): number {
  return Date.now()
}

describe('liveFeedStatus', () => {
  it('starts healthy', () => {
    resetLiveFeedStatus()
    assert.deepEqual(getLiveFeedStatus(), { degraded: false, since: null, reason: null })
  })

  it('raises the flag on the first failure, stamping since with that moment', () => {
    resetLiveFeedStatus()
    const before = now()
    reportLiveFeedFailure('edge timeout')
    const after = now()

    const status = getLiveFeedStatus()
    assert.equal(status.degraded, true)
    assert.equal(status.reason, 'edge timeout')
    assert.ok(status.since != null && status.since >= before && status.since <= after)
  })

  it('keeps the original since across repeated failures, even with a new reason', () => {
    resetLiveFeedStatus()
    reportLiveFeedFailure('first failure')
    const since = getLiveFeedStatus().since

    reportLiveFeedFailure('first failure')
    assert.equal(getLiveFeedStatus().since, since)

    reportLiveFeedFailure('different failure')
    assert.equal(getLiveFeedStatus().since, since)
    assert.equal(getLiveFeedStatus().reason, 'different failure')
  })

  it('clears everything on the next success and starts a fresh window after that', () => {
    resetLiveFeedStatus()
    reportLiveFeedFailure('outage')
    reportLiveFeedSuccess()
    assert.deepEqual(getLiveFeedStatus(), { degraded: false, since: null, reason: null })

    const before = now()
    reportLiveFeedFailure('outage again')
    const since = getLiveFeedStatus().since
    assert.ok(since != null && since >= before)
  })

  it('notifies subscribers on change and stops after unsubscribe', () => {
    resetLiveFeedStatus()
    let calls = 0
    const stop = subscribeLiveFeed(() => {
      calls += 1
    })

    reportLiveFeedFailure('outage')
    assert.equal(calls, 1)
    reportLiveFeedFailure('outage')
    assert.equal(calls, 1, 'identical failure must not re-notify')

    reportLiveFeedSuccess()
    assert.equal(calls, 2)

    stop()
    reportLiveFeedFailure('outage')
    assert.equal(calls, 2, 'unsubscribed listener must not be called')
    resetLiveFeedStatus()
  })

  it('does not notify while already healthy', () => {
    resetLiveFeedStatus()
    let calls = 0
    const stop = subscribeLiveFeed(() => {
      calls += 1
    })
    reportLiveFeedSuccess()
    assert.equal(calls, 0)
    stop()
  })

  it('resetLiveFeedStatus returns to the healthy initial state', () => {
    reportLiveFeedFailure('outage')
    resetLiveFeedStatus()
    assert.deepEqual(getLiveFeedStatus(), { degraded: false, since: null, reason: null })
  })

  it('a success token from before a failure does not clear the banner', () => {
    resetLiveFeedStatus()
    // A read starts…
    const token = getLiveFeedGeneration()
    // …and while it is in flight the edge reports a partial provider failure.
    reportLiveFeedFailure('partial provider fetch: mtapi timeout')
    // The read then "succeeds" with the partial list: the banner must stay.
    reportLiveFeedSuccess(token)
    assert.equal(getLiveFeedStatus().degraded, true)

    // The next read, started after the failure, fully succeeds → clears.
    const nextToken = getLiveFeedGeneration()
    reportLiveFeedSuccess(nextToken)
    assert.equal(getLiveFeedStatus().degraded, false)
  })

  it('bumps the generation on every failure report, even an identical reason', () => {
    resetLiveFeedStatus()
    const before = getLiveFeedGeneration()
    reportLiveFeedFailure('same reason')
    reportLiveFeedFailure('same reason')
    assert.equal(getLiveFeedGeneration(), before + 2, 'each report is observable by in-flight reads')
    assert.equal(getLiveFeedStatus().degraded, true, '…even though the visible status did not change')

    // Neither of the older tokens may clear it; only a token from after both.
    reportLiveFeedSuccess(before)
    assert.equal(getLiveFeedStatus().degraded, true)
    reportLiveFeedSuccess(before + 1)
    assert.equal(getLiveFeedStatus().degraded, true)
    reportLiveFeedSuccess(getLiveFeedGeneration())
    assert.equal(getLiveFeedStatus().degraded, false)
  })

  it('unconditional success still clears (no token = any healthy read)', () => {
    resetLiveFeedStatus()
    reportLiveFeedFailure('outage')
    reportLiveFeedSuccess()
    assert.equal(getLiveFeedStatus().degraded, false)
  })

  it('treats only auth-shaped errors as not-a-feed failure', () => {
    assert.equal(isAuthSessionError('Not signed in'), true)
    assert.equal(isAuthSessionError('JWT expired'), true)
    assert.equal(isAuthSessionError('Unauthorized'), true)
    assert.equal(isAuthSessionError('edge timeout'), false)
    assert.equal(isAuthSessionError('Not signed in.'), false, 'must be an exact match')
    assert.equal(isAuthSessionError('broker: JWT expired soon'), false, 'anchored — no partial matches')
    assert.equal(isAuthSessionError(''), false)
  })
})
