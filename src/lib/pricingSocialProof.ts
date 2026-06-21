
export type PricingSocialProofPlan = 'basic' | 'advanced'
export type PricingSocialProofTimeAgo = 'justNow' | 'oneMinute'

export interface PricingSocialProofEvent {
  id: string
  country: string
  plan: PricingSocialProofPlan
  timeAgo: PricingSocialProofTimeAgo
}

export const PRICING_SOCIAL_PROOF_BASE_COUNT = 77

export const PRICING_SOCIAL_PROOF_COUNTRIES = [
  'UK',
  'Germany',
  'France',
  'UAE',
  'Switzerland',
  'Kenya',
  'Australia',
  'Brazil',
  'Spain',
  'Netherlands',
  'Singapore',
  'Italy',
  'Mexico',
  'South Africa',
  'India',
  'Japan',
  'Poland',
  'Sweden',
  'Nigeria',
  'Portugal',
  'Malaysia',
  'Turkey',
] as const

export type PricingSocialProofCountry = (typeof PRICING_SOCIAL_PROOF_COUNTRIES)[number]

const PRICING_SOCIAL_PROOF_COUNTRY_CODES: Record<PricingSocialProofCountry, string> = {
  UK: 'GB',
  Germany: 'DE',
  France: 'FR',
  UAE: 'AE',
  Switzerland: 'CH',
  Kenya: 'KE',
  Australia: 'AU',
  Brazil: 'BR',
  Spain: 'ES',
  Netherlands: 'NL',
  Singapore: 'SG',
  Italy: 'IT',
  Mexico: 'MX',
  'South Africa': 'ZA',
  India: 'IN',
  Japan: 'JP',
  Poland: 'PL',
  Sweden: 'SE',
  Nigeria: 'NG',
  Portugal: 'PT',
  Malaysia: 'MY',
  Turkey: 'TR',
}

export function pricingSocialProofCountryFlag(country: string): string {
  const code = PRICING_SOCIAL_PROOF_COUNTRY_CODES[country as PricingSocialProofCountry] ?? 'GB'
  return String.fromCodePoint(...[...code.toUpperCase()].map(char => 127397 + char.charCodeAt(0)))
}

export interface PricingSocialProofTimeAgoLabels {
  justNow: string
  oneMinute: string
}

export function formatPricingSocialProofTimeAgo(
  timeAgo: PricingSocialProofTimeAgo,
  labels: PricingSocialProofTimeAgoLabels,
): string {
  return timeAgo === 'justNow' ? labels.justNow : labels.oneMinute
}

function pickTimeAgo(): PricingSocialProofTimeAgo {
  return Math.random() < 0.5 ? 'justNow' : 'oneMinute'
}

const FIRST_TOAST_DELAY_MS = 4000
const TOAST_INTERVAL_MIN_MS = 12000
const TOAST_INTERVAL_MAX_MS = 22000
const TOAST_VISIBLE_MS = 5000

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pickCountry(): string {
  const index = randomInt(0, PRICING_SOCIAL_PROOF_COUNTRIES.length - 1)
  return PRICING_SOCIAL_PROOF_COUNTRIES[index] ?? 'UK'
}

function pickPlan(): PricingSocialProofPlan {
  return Math.random() < 0.75 ? 'advanced' : 'basic'
}

function nextToastDelayMs(isFirst: boolean): number {
  if (isFirst) return FIRST_TOAST_DELAY_MS
  return randomInt(TOAST_INTERVAL_MIN_MS, TOAST_INTERVAL_MAX_MS)
}

let eventCounter = 0

function createEvent(): PricingSocialProofEvent {
  eventCounter += 1
  return {
    id: `pricing-social-proof-${eventCounter}-${Date.now()}`,
    country: pickCountry(),
    plan: pickPlan(),
    timeAgo: pickTimeAgo(),
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function schedulePricingSocialProofLoop(callbacks: {
  onToast: (event: PricingSocialProofEvent) => void
  onDismiss: () => void
}): () => void {
  let cancelled = false
  let scheduleTimer: number | undefined
  let dismissTimer: number | undefined
  let isFirst = true

  const clearTimers = () => {
    if (scheduleTimer != null) window.clearTimeout(scheduleTimer)
    if (dismissTimer != null) window.clearTimeout(dismissTimer)
    scheduleTimer = undefined
    dismissTimer = undefined
  }

  const scheduleNext = () => {
    if (cancelled) return
    const delay = nextToastDelayMs(isFirst)
    isFirst = false
    scheduleTimer = window.setTimeout(() => {
      if (cancelled) return
      callbacks.onToast(createEvent())
      dismissTimer = window.setTimeout(() => {
        if (cancelled) return
        callbacks.onDismiss()
        scheduleNext()
      }, TOAST_VISIBLE_MS)
    }, delay)
  }

  scheduleNext()

  return () => {
    cancelled = true
    clearTimers()
  }
}
