import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveCopierStartBlocked } from './copierStartBlocked'

const ready = {
  hasActiveSubscription: true,
  hasConnectedBroker: true,
  hasTelegramSession: true,
  hasChannels: true,
}

describe('resolveCopierStartBlocked', () => {
  it('allows start when subscription and setup are complete', () => {
    assert.deepEqual(resolveCopierStartBlocked(ready), { blocked: false, reason: null })
  })

  it('blocks without active subscription', () => {
    assert.deepEqual(
      resolveCopierStartBlocked({ ...ready, hasActiveSubscription: false }),
      { blocked: true, reason: 'subscription' },
    )
  })

  it('blocks when broker, telegram, or channels are missing', () => {
    assert.deepEqual(
      resolveCopierStartBlocked({ ...ready, hasConnectedBroker: false }),
      { blocked: true, reason: 'setup' },
    )
    assert.deepEqual(
      resolveCopierStartBlocked({ ...ready, hasTelegramSession: false }),
      { blocked: true, reason: 'setup' },
    )
    assert.deepEqual(
      resolveCopierStartBlocked({ ...ready, hasChannels: false }),
      { blocked: true, reason: 'setup' },
    )
  })
})
