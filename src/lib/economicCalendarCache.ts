import type { EconomicCalendarQuery, EconomicCalendarResponse } from './economicCalendarTypes'
import { readSessionCache } from './sessionDataCache'

/** Client cache; edge function uses ~20 min. */
export const ECONOMIC_CALENDAR_CACHE_TTL_MS = 10 * 60 * 1000

export function economicCalendarCacheKey(query: EconomicCalendarQuery = {}): string {
  const from = query.from ?? ''
  const to = query.to ?? ''
  const country = query.country ?? 'ALL'
  const impact = query.impact ?? 'all'
  return `economic-calendar:${from}:${to}:${country}:${impact}`
}

export function peekEconomicCalendarCache(
  query: EconomicCalendarQuery = {},
): { response: EconomicCalendarResponse; fetchedAt: number } | null {
  const key = economicCalendarCacheKey(query)
  const hit = readSessionCache<EconomicCalendarResponse>(key, ECONOMIC_CALENDAR_CACHE_TTL_MS)
  if (!hit) return null
  return { response: hit.data, fetchedAt: hit.fetchedAt }
}
