import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  hasValidTelegramChannelIdentity,
  isNumericTelegramChatId,
  isValidTelegramUsername,
  validateManualChannelInput,
} from './telegramChannelIdentity'

test('isNumericTelegramChatId accepts Telegram chat ids', () => {
  assert.equal(isNumericTelegramChatId('-1001234567890'), true)
  assert.equal(isNumericTelegramChatId('1234567890'), true)
  assert.equal(isNumericTelegramChatId('Test Signal Channel'), false)
})

test('isValidTelegramUsername rejects display names and spaces', () => {
  assert.equal(isValidTelegramUsername('signal_tester'), true)
  assert.equal(isValidTelegramUsername('Test Signal Channel'), false)
  assert.equal(isValidTelegramUsername('abc'), false)
})

test('hasValidTelegramChannelIdentity rejects display-name-only rows', () => {
  assert.equal(hasValidTelegramChannelIdentity({ channel_id: '-1001', channel_username: '' }), true)
  assert.equal(hasValidTelegramChannelIdentity({ channel_id: 'label', channel_username: 'signal_tester' }), true)
  assert.equal(hasValidTelegramChannelIdentity({ channel_id: 'Test Signal Channel', channel_username: '' }), false)
  assert.equal(
    hasValidTelegramChannelIdentity({ channel_id: 'Test Signal Channel', channel_username: 'Test Signal Channel' }),
    false,
  )
})

test('validateManualChannelInput rejects fake usernames', () => {
  assert.deepEqual(
    validateManualChannelInput({ display_name: 'Test', channel_id: '', channel_username: '' }),
    { ok: false, errorKey: 'identityRequired' },
  )
  assert.deepEqual(
    validateManualChannelInput({ display_name: 'Test', channel_id: '', channel_username: 'bad name' }),
    { ok: false, errorKey: 'invalidUsername' },
  )
})
