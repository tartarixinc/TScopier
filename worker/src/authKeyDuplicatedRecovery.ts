/**
 * Helpers for AUTH_KEY_DUPLICATED recovery (same Telegram session online twice).
 * Keeps poll_error spam down and spaces reconnect attempts while the old TCP dies.
 */

import { envNumber } from './envNumber'

/** True when enough time has passed since the last persisted/logged dup event. */
export function shouldEmitAuthKeyDupEvent(
  lastEmittedAtMs: number,
  nowMs = Date.now(),
  minIntervalMs = 60_000,
): boolean {
  const interval = Math.max(5_000, minIntervalMs)
  return !Number.isFinite(lastEmittedAtMs) || lastEmittedAtMs <= 0 || nowMs - lastEmittedAtMs >= interval
}

/**
 * Backoff delays (ms) before each connect attempt during AUTH_KEY_DUPLICATED recovery.
 * First delay is the normal reconnect cooldown; later delays escalate so Telegram gets
 * time to release the prior connection. Default: [cooldown, retry, 15s, 30s, 30s, 30s, ...]
 */
export function authKeyDupReconnectDelaysMs(
  initialCooldownMs: number,
  authDupDelayMs = authKeyDupReconnectDelayMs(),
  maxAttempts = authKeyDupMaxRecoveryAttempts(),
): number[] {
  const first = Math.max(500, Math.min(120_000, initialCooldownMs))
  const retry = Math.max(2_000, Math.min(120_000, authDupDelayMs))
  const attempts = Math.max(1, Math.min(100, Math.floor(maxAttempts)))
  const slots = [retry, 15_000, 30_000]
  return Array.from({ length: attempts }, (_, i) => {
    if (i === 0) return first
    return slots[i - 1] ?? 30_000
  })
}

/** Delay between AUTH_KEY_DUPLICATED recovery connect attempts. */
export function authKeyDupReconnectDelayMs(): number {
  return envNumber(process.env.TELEGRAM_AUTH_DUP_RECONNECT_DELAY_MS, 30_000, 2_000, 120_000)
}

/** Maximum connect cycles before requiring the user to re-link Telegram. */
export function authKeyDupMaxRecoveryAttempts(): number {
  // A non-numeric value used to yield NaN here, and `Array.from({ length: NaN })`
  // is an empty array — forceReconnect would then run zero attempts and report a
  // recovery it never performed.
  return Math.floor(envNumber(process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS, 4, 1, 100))
}

/** Schedule another reconnect attempt after forceReconnect exhausts retries. */
export function authKeyDupDeferredRetryMs(): number {
  return envNumber(process.env.TELEGRAM_AUTH_DUP_DEFERRED_RETRY_MS, 60_000, 15_000, 300_000)
}

export function redactTelegramConnectionLog(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '')
  return raw
    .replace(/[A-Za-z0-9+/=]{80,}/g, '[redacted]')
    .replace(/\b\d{8,15}\b/g, '[redacted]')
}
