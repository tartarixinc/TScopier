import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discordReadyWatchdogAction } from './discordReadyWatchdog'

const TIMEOUT = 5 * 60_000

test('resets the clock while the gateway is ready', () => {
  assert.equal(
    discordReadyWatchdogAction({ isReady: true, lastReadyAt: 0, now: TIMEOUT * 10, timeoutMs: TIMEOUT }),
    'reset',
  )
})

test('waits while an unready gateway is inside the timeout', () => {
  assert.equal(
    discordReadyWatchdogAction({ isReady: false, lastReadyAt: 1_000, now: 1_000 + TIMEOUT - 1, timeoutMs: TIMEOUT }),
    'wait',
  )
})

test('exits once the gateway has been unready for the full timeout', () => {
  assert.equal(
    discordReadyWatchdogAction({ isReady: false, lastReadyAt: 1_000, now: 1_000 + TIMEOUT, timeoutMs: TIMEOUT }),
    'exit',
  )
  assert.equal(
    discordReadyWatchdogAction({ isReady: false, lastReadyAt: 1_000, now: 1_000 + TIMEOUT + 60_000, timeoutMs: TIMEOUT }),
    'exit',
  )
})
