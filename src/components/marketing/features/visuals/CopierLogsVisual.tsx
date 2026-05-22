import clsx from 'clsx'
import { ChevronRight, Clock, Info } from 'lucide-react'
import { useT } from '../../../../context/LocaleContext'
import type { LandingCopierLogType } from '../../../../i18n/locales/landing/types'

const COPIER_LOG_GRID =
  'grid grid-cols-[5.75rem_minmax(0,1fr)_minmax(4.75rem,auto)_minmax(6.75rem,auto)] gap-x-3 items-center'

const TYPE_LABEL: Record<LandingCopierLogType, string> = {
  buy: 'BUY',
  sell: 'SELL',
  close: 'CLOSE',
  breakeven: 'BREAKEVEN',
  partial_profit: 'PARTIAL PROFIT',
  partial_breakeven: 'PARTIAL BE',
  modify: 'MODIFY',
}

function typeClass(type: LandingCopierLogType): string {
  if (type === 'buy') return 'text-primary-600 dark:text-teal-400'
  if (type === 'sell') return 'text-error-600 dark:text-error-400'
  if (type === 'close') return 'font-medium text-neutral-900 dark:text-neutral-100'
  return 'font-medium text-neutral-600 dark:text-neutral-400'
}

export function CopierLogsVisual() {
  const t = useT()
  const rows = t.landing.features.visuals.logs.rows

  return (
    <div className="flex h-full min-h-[300px] items-center justify-center p-3 sm:p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800 sm:px-5 sm:py-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 shrink-0 text-teal-500" aria-hidden />
            <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
              {t.dashboard.copierLogs}
            </span>
            <Info className="h-3.5 w-3.5 text-neutral-300 dark:text-neutral-400" aria-hidden />
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-teal-500 px-3 py-1.5 text-xs font-medium text-teal-600 dark:border-teal-600 dark:text-teal-400">
            {t.dashboard.copierLogs}
            <ChevronRight className="h-3 w-3" aria-hidden />
          </span>
        </div>

        <div
          className={clsx(
            COPIER_LOG_GRID,
            'border-b border-neutral-100 px-4 py-3 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:border-neutral-800 sm:px-5',
          )}
        >
          <span>{t.copierLogs.colStatus}</span>
          <span>{t.copierLogs.colSymbol}</span>
          <span>{t.copierLogs.colType}</span>
          <span className="text-right">{t.copierLogs.colTime}</span>
        </div>

        <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {rows.map((row, index) => (
            <div
              key={`${row.time}-${row.type}-${index}`}
              className={clsx(COPIER_LOG_GRID, 'px-4 py-3 sm:px-5')}
            >
              <span className="inline-flex w-fit items-center rounded-md bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
                {t.copierLogs.statusExecuted}
              </span>
              <span className="min-w-0 truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                {row.symbol ?? '—'}
              </span>
              <span className={clsx('min-w-0 truncate text-xs font-medium uppercase', typeClass(row.type))}>
                {TYPE_LABEL[row.type]}
              </span>
              <span className="text-right text-xs tabular-nums text-neutral-400">{row.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
