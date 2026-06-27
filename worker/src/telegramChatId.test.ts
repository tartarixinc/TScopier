import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isNumericTelegramChatId,
  normalizeTelegramChatId,
  toChannelIdVariants,
} from './telegramChatId'

describe('normalizeTelegramChatId', () => {
  it('canonicalizes positive ids to -100 prefix', () => {
    assert.equal(normalizeTelegramChatId('1234567890'), '-1001234567890')
  })

  it('preserves -100 prefixed ids', () => {
    assert.equal(normalizeTelegramChatId('-1001234567890'), '-1001234567890')
  })

  it('returns non-numeric unchanged', () => {
    assert.equal(normalizeTelegramChatId('not-an-id'), 'not-an-id')
  })
})

describe('isNumericTelegramChatId', () => {
  it('accepts signed numeric strings', () => {
    assert.equal(isNumericTelegramChatId('-100123'), true)
    assert.equal(isNumericTelegramChatId('abc'), false)
  })
})

describe('toChannelIdVariants', () => {
  it('includes canonical and stripped variants', () => {
    const variants = toChannelIdVariants('1234567890')
    assert.ok(variants.includes('-1001234567890'))
    assert.ok(variants.includes('1234567890'))
  })
})
