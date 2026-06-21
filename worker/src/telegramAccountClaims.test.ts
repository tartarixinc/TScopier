import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTelegramPhoneNumber } from './telegramAccountClaims'

describe('normalizeTelegramPhoneNumber', () => {
  it('strips formatting and keeps leading plus', () => {
    assert.equal(normalizeTelegramPhoneNumber('+1 (234) 567-8900'), '+12345678900')
  })

  it('converts 00 prefix to plus', () => {
    assert.equal(normalizeTelegramPhoneNumber('0044123456789'), '+44123456789')
  })
})
