import clsx from 'clsx'
import type { PerformancePeriod } from '../../lib/performanceAnalytics'

interface PerformancePeriodTabsProps {
  value: PerformancePeriod
  labels: Record<PerformancePeriod, string>
  onChange: (period: PerformancePeriod) => void
}

const PERIODS: PerformancePeriod[] = ['7d', '30d', '90d', 'all']

export function PerformancePeriodTabs({ value, labels, onChange }: PerformancePeriodTabsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={clsx(
            'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            value === p
              ? 'bg-teal-600 text-white dark:bg-teal-500'
              : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700',
          )}
        >
          {labels[p]}
        </button>
      ))}
    </div>
  )
}
