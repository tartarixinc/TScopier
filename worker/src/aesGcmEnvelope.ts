import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

/**
 * Shared AES-256-GCM envelope: `v1:<iv base64>:<ciphertext + auth tag base64>`.
 *
 * Used by broker passwords and Telegram session strings. Kept free of env
 * lookups so each caller decides which key(s) it accepts.
 */

export const ENVELOPE_PREFIX = 'v1'
const IV_LEN = 12
const TAG_LEN = 16

export function decodeKeyMaterial(raw: string): Buffer | null {
  const trimmed = String(raw ?? '').trim()
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

export function encryptEnvelope(plaintext: string, keyRaw: string): string | null {
  const key = decodeKeyMaterial(keyRaw)
  if (!key || key.length !== 32) return null

  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([encrypted, tag])
  return `${ENVELOPE_PREFIX}:${iv.toString('base64')}:${payload.toString('base64')}`
}

export function parseEnvelope(value: string | null | undefined): { iv: Buffer; payload: Buffer } | null {
  const stored = String(value ?? '').trim()
  if (!stored) return null

  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== ENVELOPE_PREFIX) return null

  let iv: Buffer
  let payload: Buffer
  try {
    iv = Buffer.from(parts[1] ?? '', 'base64')
    payload = Buffer.from(parts[2] ?? '', 'base64')
  } catch {
    return null
  }
  if (iv.length !== IV_LEN || payload.length < TAG_LEN) return null
  return { iv, payload }
}

/**
 * Returns the decoded plaintext, or null when the key does not open the value
 * (wrong key or tampered ciphertext). Does not trim: callers decide.
 */
export function decryptEnvelopeWithKey(key: Buffer, iv: Buffer, payload: Buffer): string | null {
  const tag = payload.subarray(payload.length - TAG_LEN)
  const encrypted = payload.subarray(0, payload.length - TAG_LEN)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function keyFingerprint(raw: string): string | null {
  const key = decodeKeyMaterial(raw)
  if (!key || key.length !== 32) return null
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}
