import {
  decodeKeyMaterial,
  decryptEnvelopeWithKey,
  encryptEnvelope,
  keyFingerprint,
  parseEnvelope,
} from './aesGcmEnvelope'

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

export function isBrokerCredentialsCryptoConfigured(): boolean {
  return Boolean(resolveEncryptionKeyRaw())
}

export function encryptMtPassword(plaintext: string): string | null {
  const password = plaintext.trim()
  if (!password) return null

  const keyRaw = resolveEncryptionKeyRaw()
  if (!keyRaw) return null

  return encryptEnvelope(password, keyRaw)
}

export type BrokerCredentialKeySource = 'primary' | 'previous'

export interface DecryptedMtPassword {
  plaintext: string
  /** Which configured key opened the stored value. */
  keySource: BrokerCredentialKeySource
}

function decryptWithKey(key: Buffer, iv: Buffer, payload: Buffer): string | null {
  const plain = decryptEnvelopeWithKey(key, iv, payload)
  const trimmed = String(plain ?? '').trim()
  return trimmed || null
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
 * Short, non-reversible fingerprints of the configured keys (SHA-256 of the
 * derived 32 bytes). Used to confirm that every service really holds the same
 * primary key before rewriting stored ciphertext.
 */
export function brokerCredentialKeyFingerprints(): {
  primary: string | null
  previous: string[]
} {
  const primaryRaw = resolveEncryptionKeyRaw()
  const previous = resolvePreviousEncryptionKeysRaw()
    .map(keyFingerprint)
    .filter((value): value is string => value != null)
  return {
    primary: primaryRaw ? keyFingerprint(primaryRaw) : null,
    previous,
  }
}

/**
 * Decrypt and report which key opened the value. The reencrypt diagnostic uses
 * this to tell values already on the primary (skip) from values still sealed
 * with a previous key (rewrite).
 */
export function decryptMtPasswordWithSource(
  stored: string | null | undefined,
): DecryptedMtPassword | null {
  const parsed = parseEnvelope(stored)
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
