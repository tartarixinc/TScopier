import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import {
  fetchEconomicCalendar,
  peekEconomicCalendarCache,
} from '../../lib/economicCalendarApi'
import type {
  CalendarCountryFilter,
  CalendarImpactFilter,
  EconomicCalendarEvent,
  EconomicCalendarQuery,
} from '../../lib/economicCalendarTypes'
import { fetchForexNews, peekMarketNewsCache } from '../../lib/marketNewsApi'
import { filterNewsByCalendar, groupEventsByDay } from '../../lib/newsFilter'
import type { MarketNewsArticle } from '../../lib/marketNewsTypes'
import { EconomicCalendarFilters } from '../../components/economic-calendar/EconomicCalendarFilters'
import { EconomicEventRow } from '../../components/economic-calendar/EconomicEventRow'
import { RelatedNewsPanel } from '../../components/economic-calendar/RelatedNewsPanel'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'

const COUNTRY_OPTIONS: { code: CalendarCountryFilter; labelKey?: string }[] = [
  { code: 'ALL' },
  { code: 'US', labelKey: 'US' },
  { code: 'EU', labelKey: 'EU' },
  { code: 'GB', labelKey: 'GB' },
  { code: 'JP', labelKey: 'JP' },
  { code: 'AU', labelKey: 'AU' },
  { code: 'CA', labelKey: 'CA' },
  { code: 'CH', labelKey: 'CH' },
  { code: 'NZ', labelKey: 'NZ' },
]

function defaultDateRange(): { from: string; to: string } {
  const from = new Date()
  from.setDate(from.getDate() - 1)
  const to = new Date()
  to.setDate(to.getDate() + 7)
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
}

function formatEventTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatDayHeading(day: string): string {
  const d = new Date(`${day}T12:00:00`)
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

export function EconomicCalendarPage() {
  const t = useT()
  const ec = t.economicCalendar

  const initialRange = useMemo(() => defaultDateRange(), [])
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  const [country, setCountry] = useState<CalendarCountryFilter>('ALL')
  const [impact, setImpact] = useState<CalendarImpactFilter>('all')
  const [showNewsFilter, setShowNewsFilter] = useState(false)

  const initialQuery = useMemo<EconomicCalendarQuery>(
    () => ({
      from: initialRange.from,
      to: initialRange.to,
      country: 'ALL',
      impact: 'all',
    }),
    [initialRange.from, initialRange.to],
  )
  const initialCalendarCache = peekEconomicCalendarCache(initialQuery)

  const [events, setEvents] = useState<EconomicCalendarEvent[]>(
    () => initialCalendarCache?.response.events ?? [],
  )
  const [news, setNews] = useState<MarketNewsArticle[]>([])
  const [loading, setLoading] = useState(() => !initialCalendarCache)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(() =>
    initialCalendarCache ? new Date(initialCalendarCache.fetchedAt) : null,
  )

  const countries = useMemo(
    () =>
      COUNTRY_OPTIONS.map((c) => ({
        code: c.code,
        label: c.code === 'ALL' ? ec.countryAll : (c.labelKey ?? c.code),
      })),
    [ec.countryAll],
  )

  const load = useCallback(async (isRefresh = false) => {
    const query: EconomicCalendarQuery = { from, to, country, impact }
    const calCached = !isRefresh ? peekEconomicCalendarCache(query) : null
    const newsCached = !isRefresh && showNewsFilter ? peekMarketNewsCache() : null

    if (calCached) {
      setEvents(calCached.response.events)
      setLastUpdated(new Date(calCached.fetchedAt))
    }
    if (newsCached) {
      setNews(newsCached.response.articles)
    }

    if (calCached && (!showNewsFilter || newsCached)) {
      setError(null)
      setLoading(false)
      setRefreshing(false)
      return
    }

    if (isRefresh) setRefreshing(true)
    else if (!calCached) setLoading(true)
    setError(null)
    try {
      const [calendarRes, newsRes] = await Promise.all([
        fetchEconomicCalendar(query, { forceRefresh: isRefresh }),
        showNewsFilter
          ? fetchForexNews({ forceRefresh: isRefresh })
          : Promise.resolve({ articles: [] }),
      ])
      setEvents(calendarRes.events)
      setNews(newsRes.articles)
      setLastUpdated(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : ec.loadError)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [from, to, country, impact, showNewsFilter, ec.loadError])

  useEffect(() => {
    void load()
  }, [load])

  const grouped = useMemo(() => groupEventsByDay(events), [events])

  const filteredNews = useMemo(() => {
    if (!showNewsFilter) return []
    return filterNewsByCalendar(news, events, {
      impact: impact === 'all' ? 'all' : impact,
      currency: country,
    })
  }, [showNewsFilter, news, events, impact, country])

  const impactLabel = (level: 'low' | 'medium' | 'high') => {
    if (level === 'high') return ec.impactHigh
    if (level === 'medium') return ec.impactMedium
    return ec.impactLow
  }

  const lastUpdatedLabel = lastUpdated
    ? interpolate(ec.lastUpdated, {
        time: lastUpdated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      })
    : null

  return (
    <PageShell maxWidth="lg">
      <PageHeader
        title={ec.title}
        subtitle={ec.subtitle}
        actions={(
          <>
            {lastUpdatedLabel && !loading ? (
              <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                {lastUpdatedLabel}
              </span>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              loading={refreshing}
              disabled={loading}
              onClick={() => void load(true)}
            >
              <RefreshCw className="h-4 w-4" />
              {t.common.refresh}
            </Button>
          </>
        )}
      />

      <EconomicCalendarFilters
        from={from}
        to={to}
        country={country}
        impact={impact}
        showNewsFilter={showNewsFilter}
        countries={countries}
        labels={{
          from: ec.from,
          to: ec.to,
          country: ec.country,
          impact: ec.impact,
          impactAll: ec.impactAll,
          impactHigh: ec.impactHigh,
          impactMedium: ec.impactMedium,
          impactLow: ec.impactLow,
          newsFilter: ec.newsFilter,
        }}
        onFromChange={setFrom}
        onToChange={setTo}
        onCountryChange={setCountry}
        onImpactChange={setImpact}
        onNewsFilterChange={setShowNewsFilter}
      />

      {error ? <Alert>{error}</Alert> : null}

      <div className={showNewsFilter ? 'grid gap-6 lg:grid-cols-[1fr_20rem]' : ''}>
        <div className="rounded-xl border border-neutral-200/80 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          {loading ? (
            <div className="space-y-4 p-4 animate-pulse">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-16 rounded-lg bg-neutral-100 dark:bg-neutral-800" />
              ))}
            </div>
          ) : events.length === 0 && !error ? (
            <p className="px-4 py-12 text-center text-sm text-neutral-500 dark:text-neutral-400">{ec.empty}</p>
          ) : (
            <div className="px-4">
              {[...grouped.entries()].map(([day, dayEvents]) => (
                <section key={day} className="py-2">
                  <h3 className="sticky top-0 z-10 bg-white/95 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 backdrop-blur dark:bg-neutral-900/95 dark:text-neutral-400">
                    {formatDayHeading(day)}
                  </h3>
                  {dayEvents.map((event) => (
                    <EconomicEventRow
                      key={event.id}
                      event={event}
                      timeLabel={formatEventTime(event.datetime)}
                      impactLabel={impactLabel(event.impact)}
                      labels={{
                        actual: ec.actual,
                        forecast: ec.forecast,
                        previous: ec.previous,
                      }}
                    />
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>

        {showNewsFilter ? (
          <RelatedNewsPanel
            articles={filteredNews}
            title={ec.relatedNews}
            empty={ec.relatedNewsEmpty}
            readArticle={ec.readArticle}
          />
        ) : null}
      </div>

      <footer className="border-t border-neutral-200 pt-6 dark:border-neutral-800">
        <a
          href="https://site.financialmodelingprep.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-neutral-400 hover:text-teal-600 dark:hover:text-teal-400"
        >
          {ec.dataByFmp}
        </a>
      </footer>
    </PageShell>
  )
}