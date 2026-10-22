import { createDecipheriv, createHash, randomBytes, createCipheriv } from 'crypto'

const PREFIX = 'v1'
const IV_LEN = 12

function trimEnv(key: string): string {
  return String(process.env[key] ?? '').trim()
}

function resolveEncryptionKeyRaw(): string {
  return (
    trimEnv('BROKER_CREDENTIALS_ENCRYPTION_KEY')
    || trimEnv('BROKER_CREDENTIALS_KEY')
    || trimEnv('MT_PASSWORD_ENCRYPTION_KEY')
  )
}

/**
 * Rotation support (DECRYPT ONLY): old key(s) accepted while stored values are
 * re-encrypted under the primary via diagnostics/reencryptBrokerCredentials.
 * Comma-separated list in BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS.
 */
function resolvePreviousEncryptionKeysRaw(): string[] {
  return String(process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function decodeKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }

  try {
    const buf = Buffer.from(trimmed, 'base64')
    if (buf.length === 32) return buf
  } catch {
    /* fall through */
  }

  return createHash('sha256').update(trimmed, 'utf8').digest()
}

export function isBrokerCredentialsCryptoConfigured(): boolean {
  return Boolean(resolveEncryptionKeyRaw())
}

export function encryptMtPassword(plaintext: string): string | null {
  const password = plaintext.trim()
  if (!password) return null

  const keyRaw = resolveEncryptionKeyRaw()
  if (!keyRaw) return null
  const key = decodeKeyMaterial(keyRaw)
  if (!key || key.length !== 32) return null

  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([encrypted, tag])
  return `${PREFIX}:${iv.toString('base64')}:${payload.toString('base64')}`
}

export type BrokerCredentialKeySource = 'primary' | 'previous'

export interface DecryptedMtPassword {
  plaintext: string
  /** Which configured key opened the stored value. */
  keySource: BrokerCredentialKeySource
}

function parseStoredValue(stored: string | null | undefined): { iv: Buffer; payload: Buffer } | null {
  const value = String(stored ?? '').trim()
  if (!value) return null

  const parts = value.split(':')
  if (parts.length !== 3 || parts[0] !== PREFIX) return null

  let iv: Buffer
  let payload: Buffer
  try {
    iv = Buffer.from(parts[1] ?? '', 'base64')
    payload = Buffer.from(parts[2] ?? '', 'base64')
  } catch {
    return null
  }
  if (iv.length !== IV_LEN || payload.length < 16) return null
  return { iv, payload }
}

function decryptWithKey(key: Buffer, iv: Buffer, payload: Buffer): string | null {
  const tag = payload.subarray(payload.length - 16)
  const encrypted = payload.subarray(0, payload.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8').trim()
    return plain || null
  } catch {
    return null
  }
}

function keyCandidates(): Array<{ key: Buffer; source: BrokerCredentialKeySource }> {
  const entries: Array<{ raw: string; source: BrokerCredentialKeySource }> = []
  const primary = resolveEncryptionKeyRaw()
  if (primary) entries.push({ raw: primary, source: 'primary' })
  for (const raw of resolvePreviousEncryptionKeysRaw()) entries.push({ raw, source: 'previous' })

  const seen = new Set<string>()
  const candidates: Array<{ key: Buffer; source: BrokerCredentialKeySource }> = []
  for (const entry of entries) {
    const key = decodeKeyMaterial(entry.raw)
    if (!key || key.length !== 32) continue
    const fingerprint = key.toString('hex')
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    candidates.push({ key, source: entry.source })
  }
  return candidates
}

/**
 * Decrypt and report which key opened the value. The reencrypt diagnostic uses
 * this to tell values already on the primary (skip) from values still sealed
 * with a previous key (rewrite).
 */
export function decryptMtPasswordWithSource(
  stored: string | null | undefined,
): DecryptedMtPassword | null {
  const parsed = parseStoredValue(stored)
  if (!parsed) return null

  // Try the primary key first, then any rotation predecessors. A wrong key
  // fails the GCM auth tag and falls through to the next candidate.
  for (const candidate of keyCandidates()) {
    const plaintext = decryptWithKey(candidate.key, parsed.iv, parsed.payload)
    if (plaintext != null) return { plaintext, keySource: candidate.source }
  }
  return null
}

export function decryptMtPassword(stored: string | null | undefined): string | null {
  return decryptMtPasswordWithSource(stored)?.plaintext ?? null
}
