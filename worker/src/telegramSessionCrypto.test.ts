import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  isTelegramSessionCryptoConfigured,
  openTelegramSession,
  openTelegramSessionWithSource,
  sealTelegramSession,
  telegramSessionKeyFingerprints,
  TelegramSessionDecryptError,
} from './telegramSessionCrypto'
import { TelegramSessionInvalidError } from './telegramClient'

const ENV_KEYS = [
  'TELEGRAM_SESSION_ENCRYPTION_KEY',
  'TELEGRAM_SESSION_ENCRYPTION_KEY_PREVIOUS',
] as const

const SAVED: Record<string, string | undefined> = {}

before(() => {
  for (const key of ENV_KEYS) SAVED[key] = process.env[key]
})

after(() => {
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED[key]
  }
})

function setKeys(primary: string, previous = ''): void {
  if (primary) process.env.TELEGRAM_SESSION_ENCRYPTION_KEY = primary
  else delete process.env.TELEGRAM_SESSION_ENCRYPTION_KEY
  if (previous) process.env.TELEGRAM_SESSION_ENCRYPTION_KEY_PREVIOUS = previous
  else delete process.env.TELEGRAM_SESSION_ENCRYPTION_KEY_PREVIOUS
}

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const KEY_C = 'c'.repeat(64)
const SESSION = '1A'.repeat(180)

test('round trip under the primary key', () => {
  setKeys(KEY_A)
  const stored = sealTelegramSession(SESSION)
  assert.ok(stored.startsWith('v1:'))
  assert.equal(openTelegramSession(stored), SESSION)
})

test('stored format is the shared v1 envelope', () => {
  setKeys(KEY_B, KEY_A)
  assert.match(sealTelegramSession(SESSION), /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
})

test('empty values stay empty and are never encrypted', () => {
  setKeys(KEY_A)
  assert.equal(sealTelegramSession(''), '')
  assert.equal(sealTelegramSession('   '), '')
  assert.equal(openTelegramSession(''), '')
  assert.equal(openTelegramSession(null), '')
})

test('without a configured key the value is stored unchanged', () => {
  setKeys('')
  assert.equal(isTelegramSessionCryptoConfigured(), false)
  assert.equal(sealTelegramSession(SESSION), SESSION)
  assert.equal(openTelegramSession(SESSION), SESSION)
})

test('plaintext rows still open while the key is configured (rollout window)', () => {
  setKeys(KEY_A)
  assert.equal(openTelegramSession(SESSION), SESSION)
  assert.deepEqual(openTelegramSessionWithSource(SESSION), {
    plaintext: SESSION,
    keySource: 'plaintext',
  })
})

test('old values open via the previous key during rotation', () => {
  setKeys(KEY_A)
  const oldStored = sealTelegramSession(SESSION)

  setKeys(KEY_B, KEY_A)
  assert.equal(openTelegramSession(oldStored), SESSION)
  // New writes use the primary only.
  assert.equal(openTelegramSession(sealTelegramSession(SESSION)), SESSION)
})

test('multiple previous keys are accepted', () => {
  setKeys(KEY_A)
  const stored = sealTelegramSession(SESSION)
  setKeys(KEY_C, `${KEY_B},${KEY_A}`)
  assert.equal(openTelegramSession(stored), SESSION)
})

test('a value no configured key can open throws instead of returning ciphertext', () => {
  setKeys(KEY_B)
  const stored = sealTelegramSession(SESSION)
  setKeys(KEY_A, KEY_C)
  assert.throws(() => openTelegramSession(stored), TelegramSessionDecryptError)
})

test('tampered ciphertext throws', () => {
  setKeys(KEY_A)
  const stored = sealTelegramSession(SESSION)
  const parts = stored.split(':')
  const payload = Buffer.from(parts[2]!, 'base64')
  payload[0] = payload[0]! ^ 0xff
  parts[2] = payload.toString('base64')
  assert.throws(() => openTelegramSession(parts.join(':')), TelegramSessionDecryptError)
})

test('a malformed v1 value fails closed instead of being treated as plaintext', () => {
  setKeys(KEY_A)
  assert.throws(() => openTelegramSession('v1:AAAA:BBBB'), TelegramSessionDecryptError)
  assert.throws(() => openTelegramSession('v1:'), TelegramSessionDecryptError)
  assert.throws(() => openTelegramSession('v1:AAAA'), TelegramSessionDecryptError)
})

test('a decrypt failure is never classified as an invalid session (which would delete the row)', () => {
  setKeys(KEY_B)
  const stored = sealTelegramSession(SESSION)
  setKeys(KEY_A)
  try {
    openTelegramSession(stored)
    assert.fail('expected TelegramSessionDecryptError')
  } catch (err) {
    assert.ok(err instanceof TelegramSessionDecryptError)
    // sessionManager deletes telegram_sessions rows only for this error type.
    assert.equal(err instanceof TelegramSessionInvalidError, false)
  }
})

test('reports which key opened a value', () => {
  setKeys(KEY_A)
  const oldStored = sealTelegramSession('sealed-by-a')
  setKeys(KEY_B, KEY_A)

  assert.deepEqual(openTelegramSessionWithSource(oldStored), {
    plaintext: 'sealed-by-a',
    keySource: 'previous',
  })
  assert.deepEqual(openTelegramSessionWithSource(sealTelegramSession('sealed-by-b')), {
    plaintext: 'sealed-by-b',
    keySource: 'primary',
  })
})

test('a previous entry identical to the primary is not reported as previous', () => {
  setKeys(KEY_C, KEY_C)
  assert.deepEqual(openTelegramSessionWithSource(sealTelegramSession('same-key')), {
    plaintext: 'same-key',
    keySource: 'primary',
  })
})

test('key fingerprints identify the configured keys', () => {
  setKeys(KEY_A, KEY_B)
  const fingerprint = telegramSessionKeyFingerprints()
  assert.equal(fingerprint.primary?.length, 16)
  assert.equal(fingerprint.previous.length, 1)

  setKeys('', '')
  assert.deepEqual(telegramSessionKeyFingerprints(), { primary: null, previous: [] })
})
