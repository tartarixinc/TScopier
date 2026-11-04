import {
  decodeKeyMaterial,
  decryptEnvelopeWithKey,
  encryptEnvelope,
  ENVELOPE_PREFIX,
  keyFingerprint,
  parseEnvelope,
} from './aesGcmEnvelope'

const PRIMARY_ENV = 'TELEGRAM_SESSION_ENCRYPTION_KEY'
const PREVIOUS_ENV = 'TELEGRAM_SESSION_ENCRYPTION_KEY_PREVIOUS'

function trimEnv(key: string): string {
  return String(process.env[key] ?? '').trim()
}

export function telegramSessionKeyRaw(): string {
  return trimEnv(PRIMARY_ENV)
}

/**
 * Rotation support (DECRYPT ONLY): old key(s) accepted while stored values are
 * re-encrypted under the primary via diagnostics/reencryptTelegramSessions.
 * Comma-separated list in TELEGRAM_SESSION_ENCRYPTION_KEY_PREVIOUS.
 */
function previousKeyRaws(): string[] {
  return trimEnv(PREVIOUS_ENV)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function keyCandidates(): Array<{ key: Buffer; source: TelegramSessionKeySource }> {
  const entries: Array<{ raw: string; source: TelegramSessionKeySource }> = []
  const primary = telegramSessionKeyRaw()
  if (primary) entries.push({ raw: primary, source: 'primary' })
  for (const raw of previousKeyRaws()) entries.push({ raw, source: 'previous' })

  const seen = new Set<string>()
  const candidates: Array<{ key: Buffer; source: TelegramSessionKeySource }> = []
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

export function isTelegramSessionCryptoConfigured(): boolean {
  return Boolean(telegramSessionKeyRaw())
}

export type TelegramSessionKeySource = 'primary' | 'previous'

export interface OpenedTelegramSession {
  plaintext: string
  /** 'primary'/'previous' for encrypted values, 'plaintext' for unsealed rows. */
  keySource: TelegramSessionKeySource | 'plaintext'
}

/**
 * A stored value that looks encrypted cannot be opened. Deliberately NOT a
 * TelegramSessionInvalidError: the row may be fine (for example a worker
 * started with the wrong key), so callers must never delete it on this error.
 */
export class TelegramSessionDecryptError extends Error {
  constructor(
    message = 'Your saved Telegram session could not be read. Please contact support.',
  ) {
    super(message)
    this.name = 'TelegramSessionDecryptError'
  }
}

/**
 * Value to store for a session string.
 *
 * - Empty stays empty.
 * - No key configured: returns the value unchanged (rollout before the key is set).
 * - Key configured: always encrypts; a failure throws so callers never fall
 *   back to writing plaintext.
 */
export function sealTelegramSession(value: string | null | undefined): string {
  const plaintext = String(value ?? '')
  if (!plaintext.trim()) return ''

  const keyRaw = telegramSessionKeyRaw()
  if (!keyRaw) return plaintext

  const sealed = encryptEnvelope(plaintext, keyRaw)
  if (!sealed) {
    throw new Error('Telegram session encryption key is invalid; refusing to store plaintext')
  }
  return sealed
}

/**
 * Read a stored session string.
 *
 * Plaintext rows are accepted during rollout. An encrypted row that no
 * configured key opens throws: callers must not connect with ciphertext and
 * must not overwrite the row.
 */
export function openTelegramSessionWithSource(
  value: string | null | undefined,
): OpenedTelegramSession {
  const stored = String(value ?? '')
  if (!stored.trim()) return { plaintext: '', keySource: 'plaintext' }
  if (!stored.trim().startsWith(`${ENVELOPE_PREFIX}:`)) {
    return { plaintext: stored, keySource: 'plaintext' }
  }

  // A value that is labelled as ciphertext but does not parse is damage, not a
  // legacy plaintext row: refuse it instead of connecting with or re-sealing
  // the corrupt string.
  const parsed = parseEnvelope(stored)
  if (!parsed) throw new TelegramSessionDecryptError()

  for (const candidate of keyCandidates()) {
    const plaintext = decryptEnvelopeWithKey(candidate.key, parsed.iv, parsed.payload)
    if (plaintext != null) return { plaintext, keySource: candidate.source }
  }
  throw new TelegramSessionDecryptError()
}

export function openTelegramSession(value: string | null | undefined): string {
  return openTelegramSessionWithSource(value).plaintext
}

/**
 * Short, non-reversible fingerprints of the configured keys, used to confirm
 * every service holds the same primary key before rewriting stored values.
 */
export function telegramSessionKeyFingerprints(): {
  primary: string | null
  previous: string[]
} {
  const primaryRaw = telegramSessionKeyRaw()
  const previous = previousKeyRaws()
    .map(keyFingerprint)
    .filter((value): value is string => value != null)
  return {
    primary: primaryRaw ? keyFingerprint(primaryRaw) : null,
    previous,
  }
}
