import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  isWhatsAppAuthCryptoConfigured,
  openWhatsAppAuth,
  openWhatsAppAuthColumn,
  openWhatsAppAuthWithSource,
  sealWhatsAppAuth,
  sealWhatsAppAuthColumn,
  whatsappAuthKeyFingerprints,
  WhatsAppAuthDecryptError,
} from './whatsappAuthCrypto'

const ENV_KEYS = [
  'WHATSAPP_AUTH_ENCRYPTION_KEY',
  'WHATSAPP_AUTH_ENCRYPTION_KEY_PREVIOUS',
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
  if (primary) process.env.WHATSAPP_AUTH_ENCRYPTION_KEY = primary
  else delete process.env.WHATSAPP_AUTH_ENCRYPTION_KEY
  if (previous) process.env.WHATSAPP_AUTH_ENCRYPTION_KEY_PREVIOUS = previous
  else delete process.env.WHATSAPP_AUTH_ENCRYPTION_KEY_PREVIOUS
}

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const KEY_C = 'c'.repeat(64)
const PAYLOAD = JSON.stringify({ creds: { me: { id: '111@s.whatsapp.net' } }, noise: 'x'.repeat(64) })

test('round trip under the primary key', () => {
  setKeys(KEY_A)
  const stored = sealWhatsAppAuth(PAYLOAD)
  assert.ok(stored.startsWith('v1:'))
  assert.equal(openWhatsAppAuth(stored), PAYLOAD)
})

test('stored format is the shared v1 envelope', () => {
  setKeys(KEY_B, KEY_A)
  assert.match(sealWhatsAppAuth(PAYLOAD), /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
})

test('empty values stay empty and are never encrypted', () => {
  setKeys(KEY_A)
  assert.equal(sealWhatsAppAuth(''), '')
  assert.equal(sealWhatsAppAuth('   '), '')
  assert.equal(openWhatsAppAuth(''), '')
  assert.equal(openWhatsAppAuth(null), '')
})

test('without a configured key the value is stored unchanged', () => {
  setKeys('')
  assert.equal(isWhatsAppAuthCryptoConfigured(), false)
  assert.equal(sealWhatsAppAuth(PAYLOAD), PAYLOAD)
  assert.equal(openWhatsAppAuth(PAYLOAD), PAYLOAD)
})

test('plaintext rows still open while the key is configured (rollout window)', () => {
  setKeys(KEY_A)
  assert.equal(openWhatsAppAuth(PAYLOAD), PAYLOAD)
  assert.deepEqual(openWhatsAppAuthWithSource(PAYLOAD), {
    plaintext: PAYLOAD,
    keySource: 'plaintext',
  })
})

test('old values open via the previous key during rotation', () => {
  setKeys(KEY_A)
  const oldStored = sealWhatsAppAuth(PAYLOAD)

  setKeys(KEY_B, KEY_A)
  assert.equal(openWhatsAppAuth(oldStored), PAYLOAD)
  // New writes use the primary only.
  assert.equal(openWhatsAppAuth(sealWhatsAppAuth(PAYLOAD)), PAYLOAD)
})

test('multiple previous keys are accepted', () => {
  setKeys(KEY_A)
  const stored = sealWhatsAppAuth(PAYLOAD)
  setKeys(KEY_C, `${KEY_B},${KEY_A}`)
  assert.equal(openWhatsAppAuth(stored), PAYLOAD)
})

test('a value no configured key can open throws instead of returning ciphertext', () => {
  setKeys(KEY_B)
  const stored = sealWhatsAppAuth(PAYLOAD)
  setKeys(KEY_A, KEY_C)
  assert.throws(() => openWhatsAppAuth(stored), WhatsAppAuthDecryptError)
})

test('tampered ciphertext throws', () => {
  setKeys(KEY_A)
  const stored = sealWhatsAppAuth(PAYLOAD)
  const parts = stored.split(':')
  const payload = Buffer.from(parts[2]!, 'base64')
  payload[0] = payload[0]! ^ 0xff
  parts[2] = payload.toString('base64')
  assert.throws(() => openWhatsAppAuth(parts.join(':')), WhatsAppAuthDecryptError)
})

test('a malformed v1 value fails closed instead of being treated as plaintext', () => {
  setKeys(KEY_A)
  assert.throws(() => openWhatsAppAuth('v1:AAAA:BBBB'), WhatsAppAuthDecryptError)
  assert.throws(() => openWhatsAppAuth('v1:'), WhatsAppAuthDecryptError)
  assert.throws(() => openWhatsAppAuth('v1:AAAA'), WhatsAppAuthDecryptError)
})

test('reports which key opened a value', () => {
  setKeys(KEY_A)
  const oldStored = sealWhatsAppAuth('sealed-by-a')
  setKeys(KEY_B, KEY_A)

  assert.deepEqual(openWhatsAppAuthWithSource(oldStored), {
    plaintext: 'sealed-by-a',
    keySource: 'previous',
  })
  assert.deepEqual(openWhatsAppAuthWithSource(sealWhatsAppAuth('sealed-by-b')), {
    plaintext: 'sealed-by-b',
    keySource: 'primary',
  })
})

test('key fingerprints identify the configured keys', () => {
  setKeys(KEY_A, KEY_B)
  const fingerprint = whatsappAuthKeyFingerprints()
  assert.equal(fingerprint.primary?.length, 16)
  assert.equal(fingerprint.previous.length, 1)

  setKeys('', '')
  assert.deepEqual(whatsappAuthKeyFingerprints(), { primary: null, previous: [] })
})

test('column helper stores the legacy object while unconfigured (type-stable rollout)', () => {
  setKeys('')
  const legacy = { me: { id: '111@s.whatsapp.net' } }
  const stored = sealWhatsAppAuthColumn(PAYLOAD, legacy)
  assert.equal(stored, legacy)
  assert.equal(typeof stored, 'object')
})

test('column helper stores a sealed envelope string when configured', () => {
  setKeys(KEY_A)
  const legacy = { me: { id: '111@s.whatsapp.net' } }
  const stored = sealWhatsAppAuthColumn(PAYLOAD, legacy)
  assert.equal(typeof stored, 'string')
  assert.ok(String(stored).startsWith('v1:'))
  assert.equal(openWhatsAppAuthColumn(stored), PAYLOAD)
})

test('column helper reads legacy plaintext objects and sealed strings alike', () => {
  setKeys(KEY_A)
  const legacyObject = { creds: { me: { id: '111@s.whatsapp.net' } } }
  assert.equal(openWhatsAppAuthColumn(legacyObject), JSON.stringify(legacyObject))
  assert.equal(openWhatsAppAuthColumn(sealWhatsAppAuth(PAYLOAD)), PAYLOAD)
  // A plaintext JSON string (any non-envelope value) passes through unchanged.
  assert.equal(openWhatsAppAuthColumn(PAYLOAD), PAYLOAD)
})

test('column helper never silently downgrades a sealed value without a key', () => {
  setKeys(KEY_A)
  const stored = sealWhatsAppAuth(PAYLOAD)
  setKeys('')
  assert.throws(() => openWhatsAppAuthColumn(stored), WhatsAppAuthDecryptError)
})

test('a Buffer round-trips through BufferJSON + seal + open (listener parity)', async () => {
  const baileys = await import('@whiskeysockets/baileys')
  setKeys(KEY_A)

  const original = { noise: Buffer.from('baileys-binary-payload') }
  const payload = JSON.parse(JSON.stringify(original, baileys.BufferJSON.replacer)) as typeof original

  // The listener seals the whole serialized creds/keys object, exactly like this.
  const stored = sealWhatsAppAuthColumn(JSON.stringify(payload), payload)
  assert.equal(typeof stored, 'string')
  assert.ok(String(stored).startsWith('v1:'))

  const back = JSON.parse(openWhatsAppAuthColumn(stored), baileys.BufferJSON.reviver) as typeof original
  assert.ok(Buffer.isBuffer(back.noise))
  assert.deepEqual(back.noise, original.noise)
})
