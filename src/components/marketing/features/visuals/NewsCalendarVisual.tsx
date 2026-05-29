import clsx from 'clsx'
import { ExternalLink } from 'lucide-react'
import { ImpactBadge } from '../../../economic-calendar/EconomicCalendarFilters'
import { useT } from '../../../../context/LocaleContext'
import type {
  LandingCalendarActualTone,
  LandingCalendarEventVisual,
  LandingCalendarImpact,
} from '../../../../i18n/locales/landing/types'

function impactLabel(
  impact: LandingCalendarImpact,
  labels: { high: string; medium: string; low: string },
): string {
  if (impact === 'high') return labels.high
  if (impact === 'medium') return labels.medium
  return labels.low
}

function actualClass(tone: LandingCalendarActualTone): string {
  if (tone === 'good') return 'text-emerald-600 dark:text-emerald-400'
  if (tone === 'bad') return 'text-neutral-600 dark:text-neutral-400'
  return 'text-neutral-700 dark:text-neutral-300'
}

function CalendarEventRow({
  event,
  labels,
  impactLabels,
}: {
  event: LandingCalendarEventVisual
  labels: { actual: string; forecast: string; previous: string }
  impactLabels: { high: string; medium: string; low: string }
}) {
  return (
    <div className="grid gap-2 border-b border-neutral-100 py-3 last:border-0 dark:border-neutral-800 sm:grid-cols-[4.25rem_1fr_auto] sm:items-start sm:gap-3 sm:py-3.5">
      <div className="text-xs font-semibold tabular-nums text-neutral-900 dark:text-neutral-100 sm:text-sm">
        {event.time}
      </div>
      <div className="min-w-0">
        <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-bold text-neutral-500 dark:text-neutral-400 sm:text-xs">
            {event.currency}
          </span>
          <ImpactBadge impact={event.impact} label={impactLabel(event.impact, impactLabels)} />
        </div>
        <p className="text-xs font-medium leading-snug text-neutral-900 dark:text-neutral-50 sm:text-sm">
          {event.name}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-right text-[10px] sm:min-w-[9.5rem] sm:gap-2 sm:text-xs">
        <div>
          <p className="text-neutral-400 dark:text-neutral-500">{labels.actual}</p>
          <p className={clsx('font-semibold tabular-nums', actualClass(event.actualTone))}>{event.actual}</p>
        </div>
        <div>
          <p className="text-neutral-400 dark:text-neutral-500">{labels.forecast}</p>
          <p className="font-medium tabular-nums text-neutral-700 dark:text-neutral-300">{event.forecast}</p>
        </div>
        <div>
          <p className="text-neutral-400 dark:text-neutral-500">{labels.previous}</p>
          <p className="font-medium tabular-nums text-neutral-600 dark:text-neutral-400">{event.previous}</p>
        </div>
      </div>
    </div>
  )
}

export function NewsCalendarVisual() {
  const t = useT()
  const v = t.landing.features.visuals.news
  const ec = t.economicCalendar

  const valueLabels = { actual: ec.actual, forecast: ec.forecast, previous: ec.previous }
  const impactLabels = {
    high: ec.impactHigh,
    medium: ec.impactMedium,
    low: ec.impactLow,
  }

  return (
    <div className="flex h-full min-h-[300px] items-center justify-center p-2 sm:p-4">
      <div className="flex w-full max-w-lg flex-col gap-3 sm:gap-4">
        <div className="overflow-hidden rounded-xl border border-neutral-200/80 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="px-3 sm:px-4">
            <h3 className="sticky top-0 z-10 bg-white/95 py-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 backdrop-blur dark:bg-neutral-900/95 dark:text-neutral-400 sm:text-xs">
              {v.dayHeading}
            </h3>
            {v.events.map((event) => (
              <CalendarEventRow
                key={`${event.time}-${event.name}`}
                event={event}
                labels={valueLabels}
                impactLabels={impactLabels}
              />
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-neutral-200/80 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="border-b border-neutral-100 px-3 py-2.5 dark:border-neutral-800 sm:px-4 sm:py-3">
            <h2 className="text-xs font-semibold text-neutral-900 dark:text-neutral-50 sm:text-sm">{ec.relatedNews}</h2>
          </div>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {v.articles.map((article) => (
              <div
                key={article.headline}
                className="px-3 py-2.5 sm:px-4 sm:py-3"
              >
                <p className="line-clamp-2 text-xs font-medium leading-snug text-neutral-900 dark:text-neutral-50 sm:text-sm">
                  {article.headline}
                </p>
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-neutral-500 dark:text-neutral-400 sm:text-xs">
                  <span className="truncate">{article.source}</span>
                  <span className="shrink-0 tabular-nums">{article.relativeTime}</span>
                </div>
                <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-semibold text-teal-600 dark:text-teal-400 sm:mt-2 sm:text-xs">
                  {ec.readArticle}
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
