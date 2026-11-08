import { getCookie, removeCookie, setCookie } from './cookies'

const REF_KEY = 'tsc_ref'
const REF_TS_KEY = 'tsc_ref_ts'
const REF_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const REFERRAL_CODE_MIN_LENGTH = 3
export const REFERRAL_CODE_MAX_LENGTH = 32
const REF_TTL_SECONDS = Math.floor(REF_TTL_MS / 1000)

/**
 * Single-segment app/marketing paths that must never be treated as referral codes.
 * The `/:referralCode` catch-all can otherwise capture these (e.g. verify-email).
 */
export const RESERVED_REFERRAL_PATH_SEGMENTS = new Set([
  'login',
  'signup',
  'forgot-password',
  'reset-password',
  'email-unsubscribe',
  'pricing',
  'providers',
  'verify-email',
  'auth',
  'welcome',
  'dashboard',
  'brokers',
  'account-configuration',
  'account-trades',
  'channels',
  'popular-channels',
  'copier-engine',
  'backtest',
  'copier-templates',
  'copier-logs',
  'reported-trades',
  'activities',
  'management',
  'manage-signals',
  'signals',
  'updates',
  'signal-history',
  'market-news',
  'economic-calendar',
  'contact-support',
  'feature-request',
  'partner-with-us',
  'affiliate-program',
  'billing',
  'subscriptions',
  'performance',
  'portfolio',
  'analysis-hub',
  'settings',
  'trades',
  'onboarding',
  'integrations',
  'sentiments',
  'risk-disclaimer',
  'terms',
  'privacy',
  'cookie-policy',
  'docs',
  'api',
  'assets',
])

function nowMs(): number {
  return Date.now()
}

export function normalizeReferralCode(code: string): string {
  return code.trim()
}

export function isReservedReferralPathSegment(code: string): boolean {
  return RESERVED_REFERRAL_PATH_SEGMENTS.has(normalizeReferralCode(code).toLowerCase())
}

export function referralCodeLooksValid(code: string): boolean {
  const normalized = normalizeReferralCode(code)
  if (isReservedReferralPathSegment(normalized)) return false
  return new RegExp(`^\\S{${REFERRAL_CODE_MIN_LENGTH},${REFERRAL_CODE_MAX_LENGTH}}$`, 'u').test(
    normalized,
  )
}

export function captureReferralFromUrl(search: string): string | null {
  const params = new URLSearchParams(search)
  const raw = params.get('ref') ?? ''
  const normalized = normalizeReferralCode(raw)
  if (!referralCodeLooksValid(normalized)) return null
  const now = nowMs()
  try {
    localStorage.setItem(REF_KEY, normalized)
    localStorage.setItem(REF_TS_KEY, String(now))
  } catch {
    // ignore storage issues
  }
  setCookie(REF_KEY, normalized, { maxAgeSeconds: REF_TTL_SECONDS })
  setCookie(REF_TS_KEY, String(now), { maxAgeSeconds: REF_TTL_SECONDS })
  return normalized
}

export function loadStoredReferralCode(): string | null {
  const readLocal = (): { code: string; ts: number } | null => {
    try {
      const code = normalizeReferralCode(localStorage.getItem(REF_KEY) ?? '')
      const ts = Number(localStorage.getItem(REF_TS_KEY) ?? 0)
      if (!code || !Number.isFinite(ts) || ts <= 0) return null
      return { code, ts }
    } catch {
      return null
    }
  }

  const readCookie = (): { code: string; ts: number } | null => {
    const code = normalizeReferralCode(getCookie(REF_KEY) ?? '')
    const ts = Number(getCookie(REF_TS_KEY) ?? 0)
    if (!code || !Number.isFinite(ts) || ts <= 0) return null
    return { code, ts }
  }

  const localCandidate = readLocal()
  const cookieCandidate = readCookie()

  // Clear reserved junk previously stored (e.g. verify-email from the catch-all route).
  if (
    (localCandidate && isReservedReferralPathSegment(localCandidate.code))
    || (cookieCandidate && isReservedReferralPathSegment(cookieCandidate.code))
  ) {
    clearStoredReferralCode()
    return null
  }

  const candidate = (() => {
    const validLocal =
      localCandidate && referralCodeLooksValid(localCandidate.code) ? localCandidate : null
    const validCookie =
      cookieCandidate && referralCodeLooksValid(cookieCandidate.code) ? cookieCandidate : null
    if (validLocal && validCookie) {
      return validLocal.ts >= validCookie.ts ? validLocal : validCookie
    }
    return validLocal ?? validCookie
  })()

  try {
    if (!candidate) return null
    if (nowMs() - candidate.ts > REF_TTL_MS) {
      clearStoredReferralCode()
      return null
    }
    return candidate.code
  } catch {
    return null
  }
}

export function clearStoredReferralCode(): void {
  try {
    localStorage.removeItem(REF_KEY)
    localStorage.removeItem(REF_TS_KEY)
  } catch {
    // ignore
  }
  removeCookie(REF_KEY)
  removeCookie(REF_TS_KEY)
}
