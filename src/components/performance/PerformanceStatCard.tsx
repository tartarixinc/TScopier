import type { LucideIcon } from 'lucide-react'

interface PerformanceStatCardProps {
  label: string
  value: string
  sub?: string
  icon: LucideIcon
  tone?: 'default' | 'positive' | 'negative' | 'neutral'
}

export function PerformanceStatCard({ label, value, sub, icon: Icon, tone = 'default' }: PerformanceStatCardProps) {
  const valueClass =
    tone === 'positive'
      ? 'text-teal-600 dark:text-teal-400'
      : tone === 'negative'
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-neutral-900 dark:text-neutral-50'

  return (
    <div className="rounded-xl border border-neutral-200/80 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</p>
          <p className={`mt-1 text-xl font-bold tabular-nums ${valueClass}`}>{value}</p>
          {sub ? <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">{sub}</p> : null}
        </div>
        <div className="rounded-lg bg-teal-50 p-2 text-teal-600 dark:bg-teal-950/50 dark:text-teal-400">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  )
}
