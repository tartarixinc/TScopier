import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DISCORD_BOT_PERMISSIONS, discordInviteUrl, discordShadowChannelId } from './discordInvite'

describe('discord source helpers', () => {
  it('builds a shadow channel id the listener can match', () => {
    assert.equal(discordShadowChannelId('111', '222'), 'dc:111:222')
  })

  it('invites the bot with view and history permissions', () => {
    const url = new URL(discordInviteUrl('12345', 'https://app.tscopier.ai/channels'))
    assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize')
    assert.equal(url.searchParams.get('client_id'), '12345')
    assert.equal(url.searchParams.get('scope'), 'bot')
    assert.equal(url.searchParams.get('permissions'), String(DISCORD_BOT_PERMISSIONS))
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.tscopier.ai/channels')
    assert.equal(DISCORD_BOT_PERMISSIONS, 1024 + 65536)
  })
})
