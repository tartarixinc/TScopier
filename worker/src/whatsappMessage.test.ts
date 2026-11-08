import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isWhatsAppGroupJid, whatsappMessageText } from './whatsappMessage'

describe('whatsappMessageText', () => {
  it('reads plain text, extended text, and captions', () => {
    assert.equal(whatsappMessageText({ conversation: 'BUY XAUUSD' }), 'BUY XAUUSD')
    assert.equal(whatsappMessageText({ extendedTextMessage: { text: 'SELL EURUSD' } }), 'SELL EURUSD')
    assert.equal(whatsappMessageText({ imageMessage: { caption: 'BUY GBPUSD' } }), 'BUY GBPUSD')
  })

  it('unwraps disappearing messages and skips empty posts', () => {
    assert.equal(
      whatsappMessageText({ ephemeralMessage: { message: { conversation: 'CLOSE XAUUSD' } } }),
      'CLOSE XAUUSD',
    )
    assert.equal(whatsappMessageText(null), '')
    assert.equal(whatsappMessageText({ imageMessage: { caption: '  ' } }), '')
  })
})

describe('isWhatsAppGroupJid', () => {
  it('accepts group ids and rejects direct chats and status', () => {
    assert.equal(isWhatsAppGroupJid('120363123456@g.us'), true)
    assert.equal(isWhatsAppGroupJid('15551212@s.whatsapp.net'), false)
    assert.equal(isWhatsAppGroupJid('status@broadcast'), false)
  })
})
