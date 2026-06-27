import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { isSignalChannelEnrolled } from './channelListenerConfig'

describe('isSignalChannelEnrolled', () => {
  const prevMode = process.env.CHANNEL_LISTENER_MODE
  const prevAllow = process.env.CHANNEL_LISTENER_ALLOWLIST

  after(() => {
    if (prevMode === undefined) delete process.env.CHANNEL_LISTENER_MODE
    else process.env.CHANNEL_LISTENER_MODE = prevMode
    if (prevAllow === undefined) delete process.env.CHANNEL_LISTENER_ALLOWLIST
    else process.env.CHANNEL_LISTENER_ALLOWLIST = prevAllow
  })

  it('returns false when mode is off', () => {
    process.env.CHANNEL_LISTENER_MODE = 'off'
    delete process.env.CHANNEL_LISTENER_ALLOWLIST
    assert.equal(isSignalChannelEnrolled('sc-1', '-1001', 10), false)
  })

  it('honors allowlist when set', () => {
    process.env.CHANNEL_LISTENER_MODE = 'shadow'
    process.env.CHANNEL_LISTENER_ALLOWLIST = 'allowed-id,-100999'
    assert.equal(isSignalChannelEnrolled('allowed-id', '-100888', 1), true)
    assert.equal(isSignalChannelEnrolled('other-id', '-100888', 99), false)
    assert.equal(isSignalChannelEnrolled('x', '-100999', 1), true)
  })
})
