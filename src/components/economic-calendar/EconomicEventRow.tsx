import clsx from 'clsx'
import type { EconomicCalendarEvent } from '../../lib/economicCalendarTypes'
import { ImpactBadge } from './EconomicCalendarFilters'

interface EconomicEventRowProps {
  event: EconomicCalendarEvent
  timeLabel: string
  impactLabel: string
  labels: { actual: string; forecast: string; previous: string }
}

function formatValue(n: number | null, unit: string): string {
  if (n == null) return '—'
  const base = Number.isInteger(n) ? String(n) : n.toFixed(2)
  return unit ? `${base} ${unit}`.trim() : base
}

function valueTone(actual: number | null, forecast: number | null): string {
  if (actual == null || forecast == null) return 'text-neutral-700 dark:text-neutral-300'
  if (actual > forecast) return 'text-emerald-600 dark:text-emerald-400'
  if (actual < forecast) return 'text-error-600 dark:text-error-400'
  return 'text-neutral-700 dark:text-neutral-300'
}

export function EconomicEventRow({ event, timeLabel, impactLabel, labels }: EconomicEventRowProps) {
  return (
    <div className="grid gap-3 border-b border-neutral-100 py-4 last:border-0 dark:border-neutral-800 sm:grid-cols-[5rem_1fr_auto] sm:items-start">
      <div className="text-sm font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
        {timeLabel}
      </div>
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-neutral-500 dark:text-neutral-400">
            {event.currency || event.country}
          </span>
          <ImpactBadge impact={event.impact} label={impactLabel} />
        </div>
        <p className="text-sm font-medium leading-snug text-neutral-900 dark:text-neutral-50">{event.event}</p>
      </div>
      <div className="grid grid-cols-3 gap-2 text-right text-xs sm:min-w-[12rem]">
        <div>
          <p className="text-neutral-400 dark:text-neutral-500">{labels.actual}</p>
          <p className={clsx('font-semibold tabular-nums', valueTone(event.actual, event.forecast))}>
            {formatValue(event.actual, event.unit)}
          </p>
        </div>
        <div>
          <p className="text-neutral-400 dark:text-neutral-500">{labels.forecast}</p>
          <p className="font-medium tabular-nums text-neutral-700 dark:text-neutral-300">
            {formatValue(event.forecast, event.unit)}
          </p>
        </div>
        <div>
          <p className="text-neutral-400 dark:text-neutral-500">{labels.previous}</p>
          <p className="font-medium tabular-nums text-neutral-600 dark:text-neutral-400">
            {formatValue(event.previous, event.unit)}
          </p>
        </div>
      </div>
    </div>
  )
}
