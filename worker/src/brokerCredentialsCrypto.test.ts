import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { decryptMtPassword, encryptMtPassword } from './brokerCredentialsCrypto'

const ENV_KEYS = [
  'BROKER_CREDENTIALS_ENCRYPTION_KEY',
  'BROKER_CREDENTIALS_KEY',
  'MT_PASSWORD_ENCRYPTION_KEY',
  'BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS',
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
  delete process.env.BROKER_CREDENTIALS_KEY
  delete process.env.MT_PASSWORD_ENCRYPTION_KEY
  if (primary) process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY = primary
  else delete process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY
  if (previous) process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS = previous
  else delete process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS
}

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const KEY_C = 'c'.repeat(64)

test('round trip under the primary key', () => {
  setKeys(KEY_A)
  const stored = encryptMtPassword('broker-password')
  assert.ok(stored && stored.startsWith('v1:'))
  assert.equal(decryptMtPassword(stored), 'broker-password')
})

test('decrypts old values via BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS during rotation', () => {
  // Value sealed under the OLD key (A)...
  setKeys(KEY_A)
  const oldStored = encryptMtPassword('secret-from-old-era')

  // ...primary rotated to B, A kept only as previous.
  setKeys(KEY_B, KEY_A)
  assert.equal(decryptMtPassword(oldStored), 'secret-from-old-era')

  // New writes use the primary only and still round trip.
  const newStored = encryptMtPassword('secret-from-new-era')
  assert.equal(decryptMtPassword(newStored), 'secret-from-new-era')
})

test('a value sealed by a key that is in neither list fails closed', () => {
  setKeys(KEY_B)
  const newStored = encryptMtPassword('sealed-by-b')
  // B is neither the primary nor a previous key here.
  setKeys(KEY_A, KEY_C)
  assert.equal(decryptMtPassword(newStored), null)
})

test('multiple previous keys are accepted, first match wins', () => {
  setKeys(KEY_A)
  const stored = encryptMtPassword('legacy-value')
  setKeys(KEY_C, `${KEY_B},${KEY_A}`)
  assert.equal(decryptMtPassword(stored), 'legacy-value')
})

test('no keys and malformed input return null', () => {
  setKeys('', '')
  assert.equal(decryptMtPassword('v1:AAAA:BBBB'), null)
  assert.equal(encryptMtPassword('x'), null)
  setKeys(KEY_A)
  assert.equal(decryptMtPassword('not-encrypted'), null)
  assert.equal(decryptMtPassword(null), null)
  assert.equal(decryptMtPassword('v1::'), null)
})

test('stored format never changes during rotation (v1:iv:payload)', () => {
  setKeys(KEY_B, KEY_A)
  const stored = encryptMtPassword('format-check')
  assert.match(stored!, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
})
