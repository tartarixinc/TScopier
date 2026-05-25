import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasValidTelegramChannelIdentity,
  isNumericTelegramChatId,
  validateManualChannelInput,
} from './telegramChannelIdentity'

test('isNumericTelegramChatId accepts Telegram chat ids', () => {
  assert.equal(isNumericTelegramChatId('-1001234567890'), true)
  assert.equal(isNumericTelegramChatId('1234567890'), true)
  assert.equal(isNumericTelegramChatId('Test Signal Channel'), false)
  assert.equal(isNumericTelegramChatId(''), false)
})

test('hasValidTelegramChannelIdentity accepts numeric id or username', () => {
  assert.equal(hasValidTelegramChannelIdentity({ channel_id: '-1001', channel_username: '' }), true)
  assert.equal(hasValidTelegramChannelIdentity({ channel_id: 'label', channel_username: 'signals2' }), true)
  assert.equal(hasValidTelegramChannelIdentity({ channel_id: 'Test Signal Channel', channel_username: '' }), false)
})

test('validateManualChannelInput rejects display-name-only rows', () => {
  assert.deepEqual(
    validateManualChannelInput({ display_name: 'Test', channel_id: '', channel_username: '' }),
    { ok: false, errorKey: 'identityRequired' },
  )
  assert.deepEqual(
    validateManualChannelInput({ display_name: 'Test', channel_id: 'not-numeric', channel_username: '' }),
    { ok: false, errorKey: 'invalidChannelId' },
  )
})
