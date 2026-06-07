import clsx from 'clsx'
import { useT } from '../../../context/LocaleContext'
import { Badge } from '../../ui/Badge'

export function StepConfigureVisual() {
  const t = useT()
  const v = t.landing.steps.visuals.configure
  const filters = t.landing.features.visuals.filters

  return (
    <div className="flex h-full min-h-[220px] items-stretch p-3 sm:p-4">
      <div className="flex w-full flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
          <div className="flex min-w-0 items-center gap-2">
            <img src="/MT5.png" alt="" className="h-8 w-8 object-contain" aria-hidden />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-neutral-900 dark:text-neutral-50">{v.accountName}</p>
              <p className="text-[10px] text-neutral-500 dark:text-neutral-400">{v.login}</p>
            </div>
          </div>
          <Badge variant="primary" size="sm">
            {t.accountConfig.brokerList.statusConnected}
          </Badge>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-2 dark:border-neutral-800 dark:bg-neutral-800/50">
              <span className="text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
                {t.backtest.lotSize}
              </span>
              <p className="mt-0.5 text-sm font-semibold tabular-nums text-neutral-900 dark:text-neutral-50">
                {v.lotSize}
              </p>
            </label>
            <label className="rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-2 dark:border-neutral-800 dark:bg-neutral-800/50">
              <span className="text-[10px] font-medium text-neutral-500 dark:text-neutral-400">{v.rangeLabel}</span>
              <p className="mt-0.5 text-sm font-semibold text-teal-700 dark:text-teal-400">{v.rangeValue}</p>
            </label>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400">TP split</p>
            <div className="flex flex-wrap gap-1.5">
              {v.tpRows.map((row) => (
                <span
                  key={row.label}
                  className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-[10px] font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                >
                  {row.label} · {row.percent}
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            {v.filters.map((rule) => (
              <div
                key={rule.label}
                className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 px-2.5 py-2 dark:border-neutral-800"
              >
                <span className="truncate text-[10px] text-neutral-700 dark:text-neutral-200">{rule.label}</span>
                <div
                  className="inline-flex shrink-0 items-center rounded-md border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-800/50"
                  aria-hidden
                >
                  <span
                    className={clsx(
                      'rounded px-1.5 py-0.5 text-[10px]',
                      rule.decision === 'allow'
                        ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-50'
                        : 'text-neutral-400',
                    )}
                  >
                    {filters.allowLabel}
                  </span>
                  <span
                    className={clsx(
                      'rounded px-1.5 py-0.5 text-[10px]',
                      rule.decision === 'ignore'
                        ? 'bg-amber-50 text-amber-700 shadow-sm'
                        : 'text-neutral-400',
                    )}
                  >
                    {filters.ignoreLabel}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
