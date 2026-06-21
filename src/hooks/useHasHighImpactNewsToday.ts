import { useCallback, useEffect, useState } from 'react'
import { fetchEconomicCalendar, peekEconomicCalendarCache } from '../lib/economicCalendarApi'
import type { CalendarCountryFilter } from '../lib/economicCalendarTypes'

const REFRESH_MS = 15 * 60 * 1000

function todayIsoDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function useHasHighImpactNewsToday(enabled = true): boolean {
  const [hasHighImpact, setHasHighImpact] = useState(false)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setHasHighImpact(false)
      return
    }

    const today = todayIsoDate()
    const query = {
      from: today,
      to: today,
      country: 'ALL' as CalendarCountryFilter,
      impact: 'high' as const,
    }

    const cached = peekEconomicCalendarCache(query)
    if (cached) {
      setHasHighImpact(cached.response.events.length > 0)
    }

    try {
      const res = await fetchEconomicCalendar(query)
      setHasHighImpact(res.events.length > 0)
    } catch {
      if (!cached) setHasHighImpact(false)
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!enabled) return

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REFRESH_MS)

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refresh])

  return hasHighImpact
}
