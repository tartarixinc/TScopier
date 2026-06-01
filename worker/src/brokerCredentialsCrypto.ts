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

export function decryptMtPassword(stored: string | null | undefined): string | null {
  const value = String(stored ?? '').trim()
  if (!value) return null

  const parts = value.split(':')
  if (parts.length !== 3 || parts[0] !== PREFIX) return null

  const keyRaw = resolveEncryptionKeyRaw()
  if (!keyRaw) return null
  const key = decodeKeyMaterial(keyRaw)
  if (!key || key.length !== 32) return null

  let iv: Buffer
  let payload: Buffer
  try {
    iv = Buffer.from(parts[1] ?? '', 'base64')
    payload = Buffer.from(parts[2] ?? '', 'base64')
  } catch {
    return null
  }
  if (iv.length !== IV_LEN || payload.length < 16) return null

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
