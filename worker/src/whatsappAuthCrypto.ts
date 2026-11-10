import {
  decodeKeyMaterial,
  decryptEnvelopeWithKey,
  encryptEnvelope,
  ENVELOPE_PREFIX,
  keyFingerprint,
  parseEnvelope,
} from './aesGcmEnvelope'

const PRIMARY_ENV = 'WHATSAPP_AUTH_ENCRYPTION_KEY'
const PREVIOUS_ENV = 'WHATSAPP_AUTH_ENCRYPTION_KEY_PREVIOUS'

function trimEnv(key: string): string {
  return String(process.env[key] ?? '').trim()
}

export function whatsappAuthKeyRaw(): string {
  return trimEnv(PRIMARY_ENV)
}

/**
 * Rotation support (DECRYPT ONLY): old key(s) accepted while stored values are
 * re-encrypted under the primary via diagnostics/reencryptWhatsAppAuth.
 * Comma-separated list in WHATSAPP_AUTH_ENCRYPTION_KEY_PREVIOUS.
 */
function previousKeyRaws(): string[] {
  return trimEnv(PREVIOUS_ENV)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function keyCandidates(): Array<{ key: Buffer; source: WhatsAppAuthKeySource }> {
  const entries: Array<{ raw: string; source: WhatsAppAuthKeySource }> = []
  const primary = whatsappAuthKeyRaw()
  if (primary) entries.push({ raw: primary, source: 'primary' })
  for (const raw of previousKeyRaws()) entries.push({ raw, source: 'previous' })

  const seen = new Set<string>()
  const candidates: Array<{ key: Buffer; source: WhatsAppAuthKeySource }> = []
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

export function isWhatsAppAuthCryptoConfigured(): boolean {
  return Boolean(whatsappAuthKeyRaw())
}

export type WhatsAppAuthKeySource = 'primary' | 'previous'

export interface OpenedWhatsAppAuth {
  plaintext: string
  /** 'primary'/'previous' for encrypted values, 'plaintext' for unsealed rows. */
  keySource: WhatsAppAuthKeySource | 'plaintext'
}

/**
 * A stored value that looks encrypted cannot be opened. Deliberately NOT a
 * "session invalid" error: the row may be fine (for example a worker started
 * with the wrong key), so callers must never delete it on this error.
 */
export class WhatsAppAuthDecryptError extends Error {
  constructor(
    message = 'Your saved WhatsApp session could not be read. Please contact support.',
  ) {
    super(message)
    this.name = 'WhatsAppAuthDecryptError'
  }
}

/**
 * Value to store for one whatsapp_auth jsonb payload (creds or keys text).
 *
 * - Empty stays empty.
 * - No key configured: returns the value unchanged (rollout before the key is set).
 * - Key configured: always encrypts; a failure throws so callers never fall
 *   back to writing plaintext.
 */
export function sealWhatsAppAuth(value: string | null | undefined): string {
  const plaintext = String(value ?? '')
  if (!plaintext.trim()) return ''

  const keyRaw = whatsappAuthKeyRaw()
  if (!keyRaw) return plaintext

  const sealed = encryptEnvelope(plaintext, keyRaw)
  if (!sealed) {
    throw new Error('WhatsApp auth encryption key is invalid; refusing to store plaintext')
  }
  return sealed
}

/**
 * Read a stored auth payload as JSON text (ready for JSON.parse with the
 * Baileys BufferJSON reviver).
 *
 * Plaintext rows are accepted during rollout. An encrypted value that no
 * configured key opens throws: callers must not build a session from ciphertext
 * and must not overwrite the row.
 */
export function openWhatsAppAuthWithSource(value: string | null | undefined): OpenedWhatsAppAuth {
  const stored = String(value ?? '')
  if (!stored.trim()) return { plaintext: '', keySource: 'plaintext' }
  if (!stored.trim().startsWith(`${ENVELOPE_PREFIX}:`)) {
    return { plaintext: stored, keySource: 'plaintext' }
  }

  // A value labelled as ciphertext that does not parse is damage, not a legacy
  // row: refuse it instead of connecting with or re-sealing the corrupt string.
  const parsed = parseEnvelope(stored)
  if (!parsed) throw new WhatsAppAuthDecryptError()

  for (const candidate of keyCandidates()) {
    const plaintext = decryptEnvelopeWithKey(candidate.key, parsed.iv, parsed.payload)
    if (plaintext != null) return { plaintext, keySource: candidate.source }
  }
  throw new WhatsAppAuthDecryptError()
}

export function openWhatsAppAuth(value: string | null | undefined): string {
  return openWhatsAppAuthWithSource(value).plaintext
}

/**
 * Read one `whatsapp_auth` jsonb column value as JSON text.
 *
 * - Sealed string (`v1:…` envelope) → decrypted with primary/previous key.
 * - Plaintext string → passed through (legacy/rollout).
 * - Object → re-serialized (legacy rows store the JSON object itself, matching
 *   the pre-encryption `JSON.parse(JSON.stringify(value), reviver)` read).
 */
export function openWhatsAppAuthColumn(value: unknown): string {
  if (typeof value === 'string') return openWhatsAppAuth(value)
  return JSON.stringify(value ?? null)
}

/**
 * Value for one `whatsapp_auth` jsonb column on write.
 *
 * - No key configured: store the legacy object so the stored type stays
 *   byte-identical to pre-encryption behaviour.
 * - Key configured: store the sealed `v1:…` envelope of `jsonText`; sealing
 *   failures throw so a broken key can never silently write plaintext.
 */
export function sealWhatsAppAuthColumn(jsonText: string, legacyValue: unknown): unknown {
  if (!isWhatsAppAuthCryptoConfigured()) return legacyValue
  return sealWhatsAppAuth(jsonText)
}

/**
 * Short, non-reversible fingerprints of the configured keys, used to confirm
 * every service holds the same primary key before rewriting stored values.
 */
export function whatsappAuthKeyFingerprints(): {
  primary: string | null
  previous: string[]
} {
  const primaryRaw = whatsappAuthKeyRaw()
  const previous = previousKeyRaws()
    .map(keyFingerprint)
    .filter((value): value is string => value != null)
  return {
    primary: primaryRaw ? keyFingerprint(primaryRaw) : null,
    previous,
  }
}
