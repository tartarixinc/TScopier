import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveCopierStartBlocked } from './copierStartBlocked'

const ready = {
  hasActiveSubscription: true,
  hasConnectedBroker: true,
  hasTelegramSession: true,
  hasChannels: true,
  hasTradingViewWebhook: false,
  hasDiscordChannel: false,
  hasWhatsAppSource: false,
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

  it('blocks when broker is missing or no signal source exists', () => {
    assert.deepEqual(
      resolveCopierStartBlocked({ ...ready, hasConnectedBroker: false }),
      { blocked: true, reason: 'setup' },
    )
    assert.deepEqual(
      resolveCopierStartBlocked({ ...ready, hasTelegramSession: false, hasTradingViewWebhook: false }),
      { blocked: true, reason: 'setup' },
    )
    assert.deepEqual(
      resolveCopierStartBlocked({ ...ready, hasChannels: false, hasTradingViewWebhook: false }),
      { blocked: true, reason: 'setup' },
    )
  })

  it('allows TradingView alone without a Telegram session or channel', () => {
    assert.deepEqual(
      resolveCopierStartBlocked({
        ...ready,
        hasTelegramSession: false,
        hasChannels: false,
        hasTradingViewWebhook: true,
      }),
      { blocked: false, reason: null },
    )
  })

  it('allows WhatsApp alone when a session is linked and a group is added', () => {
    assert.deepEqual(
      resolveCopierStartBlocked({
        ...ready,
        hasTelegramSession: false,
        hasChannels: false,
        hasTradingViewWebhook: false,
        hasDiscordChannel: false,
        hasWhatsAppSource: true,
      }),
      { blocked: false, reason: null },
    )
  })
})
