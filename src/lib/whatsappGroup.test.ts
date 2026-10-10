import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isWhatsAppGroupJid, whatsappShadowChannelId } from './whatsappGroup'

describe('whatsapp group helpers', () => {
  it('builds a shadow channel id the copier can store', () => {
    assert.equal(whatsappShadowChannelId('120363123@g.us'), 'wa:120363123@g.us')
  })

  it('accepts only group ids', () => {
    assert.equal(isWhatsAppGroupJid('120363123@g.us'), true)
    assert.equal(isWhatsAppGroupJid('15551212@s.whatsapp.net'), false)
  })
})
