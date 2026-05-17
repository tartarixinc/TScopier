import { supabase } from './supabase'
import {
  ECONOMIC_CALENDAR_CACHE_TTL_MS,
  economicCalendarCacheKey,
} from './economicCalendarCache'
import type { EconomicCalendarQuery, EconomicCalendarResponse } from './economicCalendarTypes'
import { fetchWithSessionCache } from './sessionDataCache'

export { peekEconomicCalendarCache } from './economicCalendarCache'

async function fetchEconomicCalendarFromNetwork(
  query: EconomicCalendarQuery = {},
): Promise<EconomicCalendarResponse> {
  const session = (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')

  const params = new URLSearchParams()
  if (query.from) params.set('from', query.from)
  if (query.to) params.set('to', query.to)
  if (query.country) params.set('country', query.country)
  if (query.impact) params.set('impact', query.impact)

  const qs = params.toString()
  const base = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/economic-calendar`
  const url = qs ? `${base}?${qs}` : base

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      },
    })
  } catch {
    throw new Error(
      'Could not reach economic-calendar. Deploy the edge function and set FMP_API_KEY (see docs/economic-calendar-setup.md).',
    )
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : text || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data as EconomicCalendarResponse
}

export async function fetchEconomicCalendar(
  query: EconomicCalendarQuery = {},
  options?: { forceRefresh?: boolean },
): Promise<EconomicCalendarResponse> {
  const key = economicCalendarCacheKey(query)
  const { data } = await fetchWithSessionCache(
    key,
    ECONOMIC_CALENDAR_CACHE_TTL_MS,
    () => fetchEconomicCalendarFromNetwork(query),
    { forceRefresh: options?.forceRefresh },
  )
  return data
}
