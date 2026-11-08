import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { flattenDiscordMessage } from './discordMessage'

describe('flattenDiscordMessage', () => {
  it('joins message text with embed title, description, and fields', () => {
    const text = flattenDiscordMessage('BUY XAUUSD', [
      {
        title: 'Gold',
        description: 'Entry now',
        fields: [{ name: 'SL', value: '2300' }],
      },
    ])
    assert.equal(text, 'BUY XAUUSD\nGold\nEntry now\nSL\n2300')
  })

  it('returns an empty string when the post has no text', () => {
    assert.equal(flattenDiscordMessage('  ', []), '')
  })
})
