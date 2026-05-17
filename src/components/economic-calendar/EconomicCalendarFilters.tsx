import clsx from 'clsx'
import type { CalendarCountryFilter, CalendarImpactFilter } from '../../lib/economicCalendarTypes'

interface EconomicCalendarFiltersProps {
  from: string
  to: string
  country: CalendarCountryFilter
  impact: CalendarImpactFilter
  showNewsFilter: boolean
  countries: { code: string; label: string }[]
  labels: {
    from: string
    to: string
    country: string
    impact: string
    impactAll: string
    impactHigh: string
    impactMedium: string
    impactLow: string
    newsFilter: string
  }
  onFromChange: (v: string) => void
  onToChange: (v: string) => void
  onCountryChange: (v: CalendarCountryFilter) => void
  onImpactChange: (v: CalendarImpactFilter) => void
  onNewsFilterChange: (v: boolean) => void
}

const inputClass =
  'rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100'

export function EconomicCalendarFilters({
  from,
  to,
  country,
  impact,
  showNewsFilter,
  countries,
  labels,
  onFromChange,
  onToChange,
  onCountryChange,
  onImpactChange,
  onNewsFilterChange,
}: EconomicCalendarFiltersProps) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-neutral-200/80 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{labels.from}</span>
          <input type="date" className={inputClass} value={from} onChange={(e) => onFromChange(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{labels.to}</span>
          <input type="date" className={inputClass} value={to} onChange={(e) => onToChange(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{labels.country}</span>
          <select className={inputClass} value={country} onChange={(e) => onCountryChange(e.target.value)}>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{labels.impact}</span>
          <select
            className={inputClass}
            value={impact}
            onChange={(e) => onImpactChange(e.target.value as CalendarImpactFilter)}
          >
            <option value="all">{labels.impactAll}</option>
            <option value="high">{labels.impactHigh}</option>
            <option value="medium">{labels.impactMedium}</option>
            <option value="low">{labels.impactLow}</option>
          </select>
        </label>
      </div>
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
        <input
          type="checkbox"
          checked={showNewsFilter}
          onChange={(e) => onNewsFilterChange(e.target.checked)}
          className="h-4 w-4 rounded border-neutral-300 text-teal-600 focus:ring-teal-500"
        />
        {labels.newsFilter}
      </label>
    </div>
  )
}

export function ImpactBadge({ impact, label }: { impact: 'low' | 'medium' | 'high'; label: string }) {
  return (
    <span
      className={clsx(
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        impact === 'high' && 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
        impact === 'medium' && 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
        impact === 'low' && 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
      )}
    >
      {label}
    </span>
  )
}
