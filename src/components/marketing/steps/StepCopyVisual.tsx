import clsx from 'clsx'
import { ChevronRight, Clock, Info } from 'lucide-react'
import { useT } from '../../../context/LocaleContext'

const LOG_GRID =
  'grid grid-cols-[5.75rem_minmax(0,1fr)_minmax(4.75rem,auto)_minmax(5.5rem,auto)] gap-x-2 items-center'

export function StepCopyVisual() {
  const t = useT()
  const v = t.landing.steps.visuals.copy

  return (
    <div className="flex h-full min-h-[220px] items-stretch p-3 sm:p-4">
      <div className="flex w-full flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="border-b border-neutral-100 px-3 py-2 dark:border-neutral-800 sm:px-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-teal-500" aria-hidden />
              <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-50">
                {t.dashboard.tradeActivities}
              </span>
              <Info className="h-3 w-3 text-neutral-300 dark:text-neutral-400" aria-hidden />
            </div>
            <span className="inline-flex items-center gap-1 rounded-lg border border-teal-500 px-2 py-1 text-[10px] font-medium text-teal-600 dark:border-teal-600 dark:text-teal-400">
              {t.nav.items.channels}
              <ChevronRight className="h-2.5 w-2.5" aria-hidden />
            </span>
          </div>
        </div>

        <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {v.workerLogs.map((log) => (
            <div key={log.message} className="px-3 py-2 sm:px-4">
              <p className="text-[11px] leading-snug text-neutral-800 dark:text-neutral-100">{log.message}</p>
              <p className="mt-0.5 text-[10px] text-neutral-400">{log.time}</p>
            </div>
          ))}
        </div>

        <div className="border-t border-neutral-100 dark:border-neutral-800">
          <div className="flex items-center gap-1.5 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800 sm:px-4">
            <Clock className="h-3.5 w-3.5 text-teal-500" aria-hidden />
            <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-50">
              {t.dashboard.copierLogs}
            </span>
          </div>
          <div
            className={clsx(
              LOG_GRID,
              'border-b border-neutral-100 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:border-neutral-800 sm:px-4',
            )}
          >
            <span>{t.copierLogs.colStatus}</span>
            <span>{t.copierLogs.colSymbol}</span>
            <span>{t.copierLogs.colType}</span>
            <span className="text-right">{t.copierLogs.colTime}</span>
          </div>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {v.logRows.map((row) => (
              <div key={`${row.time}-${row.type}`} className={clsx(LOG_GRID, 'px-3 py-2 sm:px-4')}>
                <span className="inline-flex w-fit rounded-md bg-teal-50 px-1.5 py-0.5 text-[10px] font-medium text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
                  {t.copierLogs.statusExecuted}
                </span>
                <span className="truncate text-xs font-medium text-neutral-900 dark:text-neutral-50">
                  {row.symbol}
                </span>
                <span
                  className={clsx(
                    'truncate text-[10px] font-medium uppercase',
                    row.type === 'buy' ? 'text-primary-600 dark:text-teal-400' : 'text-error-600',
                  )}
                >
                  {row.type}
                </span>
                <span className="text-right text-[10px] tabular-nums text-neutral-400">{row.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
