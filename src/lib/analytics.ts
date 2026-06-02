import { getCookie, setCookie } from './cookies'
import { loadStoredReferralCode } from './referralCapture'
import { trackGaEvent } from './googleAnalytics'

const ANALYTICS_ID_KEY = 'tsc_analytics_id'
const ANALYTICS_SESSION_KEY = 'tsc_analytics_session'
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
const SIX_HOURS_MS = 6 * 60 * 60 * 1000

type EventPayload = Record<string, unknown>

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function getOrCreateAnalyticsId(): string {
  const existing = getCookie(ANALYTICS_ID_KEY)
  if (existing) return existing
  const created = randomId('aid')
  setCookie(ANALYTICS_ID_KEY, created, { maxAgeSeconds: ONE_YEAR_SECONDS })
  return created
}

function getOrCreateSessionId(): string {
  if (typeof sessionStorage === 'undefined') return randomId('sid')
  const existingRaw = sessionStorage.getItem(ANALYTICS_SESSION_KEY)
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as { id: string; ts: number }
      if (Date.now() - parsed.ts < SIX_HOURS_MS) {
        return parsed.id
      }
    } catch {
      // ignore parse issue, regenerate
    }
  }
  const id = randomId('sid')
  sessionStorage.setItem(ANALYTICS_SESSION_KEY, JSON.stringify({ id, ts: Date.now() }))
  return id
}

export function trackMarketingEvent(eventName: string, payload: EventPayload = {}): void {
  if (typeof window === 'undefined') return
  const referral = loadStoredReferralCode()
  const event = {
    event: eventName,
    ts: Date.now(),
    analytics_id: getOrCreateAnalyticsId(),
    session_id: getOrCreateSessionId(),
    referral_code: referral,
    path: window.location.pathname,
    ...payload,
  }

  window.dataLayer = window.dataLayer ?? []
  window.dataLayer.push(event as Record<string, unknown>)
  trackGaEvent(eventName, {
    analytics_id: event.analytics_id,
    session_id: event.session_id,
    referral_code: event.referral_code,
    path: event.path,
    ...payload,
  })

  // Keep a small local session buffer for debug/QA.
  try {
    const key = 'tsc_marketing_events'
    const existing = JSON.parse(sessionStorage.getItem(key) ?? '[]') as unknown[]
    const next = [...existing, event].slice(-100)
    sessionStorage.setItem(key, JSON.stringify(next))
  } catch {
    // ignore storage issues
  }
}

