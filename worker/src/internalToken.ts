/**
 * Shared WORKER_INTERNAL_TOKEN helpers — trim on both sides so trailing newlines
 * in Railway env values cannot cause permanent 401s on /internal/* routes.
 */

export function configuredInternalToken(): string {
  return String(process.env.WORKER_INTERNAL_TOKEN ?? '').trim()
}

export function requestInternalToken(header: string | string[] | undefined): string {
  if (Array.isArray(header)) return String(header[0] ?? '').trim()
  return String(header ?? '').trim()
}

export function internalTokenMatches(header: string | string[] | undefined): boolean {
  const expected = configuredInternalToken()
  if (!expected) return false
  return requestInternalToken(header) === expected
}

/** Short fingerprint for startup logs (never log the full secret). */
export function internalTokenFingerprint(): string | null {
  const token = configuredInternalToken()
  if (!token) return null
  if (token.length <= 8) return `${token.length}ch`
  return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length}ch)`
}
