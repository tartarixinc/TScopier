import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { isLossPnl, lossTextClass, pnlSignTextClass, profitTextClass } from '../../lib/pnlDisplay'

interface PerformanceStatCardProps {
  label: string
  value: string
  /** Numeric amount used for sign coloring (preferred over tone alone). */
  amount?: number | null
  sub?: ReactNode
  icon: LucideIcon
  tone?: 'default' | 'positive' | 'negative' | 'neutral'
}

export function PerformanceStatCard({
  label,
  value,
  amount,
  sub,
  icon: Icon,
  tone = 'default',
}: PerformanceStatCardProps) {
  const signedTone =
    amount != null && Number.isFinite(amount)
      ? amount > 0
        ? 'positive'
        : amount < 0
          ? 'negative'
          : 'neutral'
      : tone

  const valueClass =
    amount != null && Number.isFinite(amount)
      ? pnlSignTextClass(amount)
      : signedTone === 'positive'
        ? profitTextClass
        : signedTone === 'negative'
          ? lossTextClass
          : 'text-neutral-900 dark:text-neutral-50'

  const iconWrapClass =
    signedTone === 'negative' || isLossPnl(amount ?? NaN)
      ? 'bg-error-50 text-[#737373] dark:bg-error-950/40'
      : 'bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-400'

  return (
    <div className="rounded-xl border border-neutral-200/80 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</p>
          <p className={`mt-1 text-xl font-bold tabular-nums ${valueClass}`}>{value}</p>
          {sub ? <div className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">{sub}</div> : null}
        </div>
        <div className={clsx('rounded-lg p-2', iconWrapClass)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  )
}
