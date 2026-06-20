import clsx from 'clsx'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useT } from '../../../../context/LocaleContext'
import { lossBarClass, lossTextClass, profitTextClass } from '../../../../lib/pnlDisplay'
import type { LandingBacktestPipsTone } from '../../../../i18n/locales/landing/types'

function pipsClass(tone: LandingBacktestPipsTone): string {
  if (tone === 'good') return profitTextClass
  if (tone === 'bad') return lossTextClass
  return 'text-neutral-600 dark:text-neutral-400'
}

function toneBarClass(tone: LandingBacktestPipsTone): string {
  if (tone === 'good') return 'bg-teal-500'
  if (tone === 'bad') return lossBarClass
  return 'bg-neutral-300 dark:bg-neutral-600'
}

export function BacktestVisual() {
  const v = useT().landing.features.visuals.backtest
  const winLossParts = v.winLoss.split('/')
  const winLossWins = winLossParts[0]?.trim() ?? v.winLoss
  const winLossLosses = winLossParts[1]?.trim() ?? ''

  return (
    <div className="flex h-full min-h-[260px] items-center justify-center p-3 sm:p-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-start justify-between gap-2 px-4 pt-4 pb-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{v.resultsTitle}</p>
            <p className="mt-0.5 truncate text-[10px] text-neutral-500 dark:text-neutral-400">
              {v.resultsSubtitle}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400">
            <ArrowLeft className="h-3 w-3" aria-hidden />
            {v.newRunLabel}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 px-4 pb-3 sm:grid-cols-4">
          <div className="rounded-xl border border-neutral-200 p-2.5 dark:border-neutral-800">
            <p className="text-[9px] font-medium uppercase tracking-wide text-neutral-400">{v.totalPipsLabel}</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums text-teal-600 dark:text-teal-400 sm:text-xl">
              {v.totalPips}
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 p-2.5 dark:border-neutral-800">
            <p className="text-[9px] font-medium uppercase tracking-wide text-neutral-400">{v.winRateLabel}</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums text-neutral-900 dark:text-neutral-50 sm:text-xl">
              {v.winRate}
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 p-2.5 dark:border-neutral-800">
            <p className="text-[9px] font-medium uppercase tracking-wide text-neutral-400">{v.winLossLabel}</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums sm:text-xl">
              {winLossLosses ? (
                <>
                  <span className={profitTextClass}>{winLossWins}</span>
                  <span className="text-neutral-300 dark:text-neutral-600">/</span>
                  <span className={lossTextClass}>{winLossLosses}</span>
                </>
              ) : (
                v.winLoss
              )}
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 p-2.5 dark:border-neutral-800">
            <p className="text-[9px] font-medium uppercase tracking-wide text-neutral-400">{v.signalsLabel}</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums text-neutral-900 dark:text-neutral-50 sm:text-xl">
              {v.signalsCount}
            </p>
          </div>
        </div>

        <div className="border-t border-neutral-100 dark:border-neutral-800">
          <p className="px-4 py-2 text-xs font-medium text-neutral-700 dark:text-neutral-200">
            {v.signalsListLabel}
          </p>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {v.signals.map((signal) => (
              <li
                key={`${signal.symbol}-${signal.timestamp}`}
                className="flex items-center gap-3 px-4 py-3"
                aria-hidden
              >
                <div
                  className={clsx(
                    'w-1 min-h-[2.5rem] shrink-0 self-stretch rounded-full',
                    toneBarClass(signal.pipsTone),
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {signal.symbol}
                    <span
                      className={clsx(
                        'ml-2 text-[10px] font-semibold uppercase',
                        signal.side === 'buy' ? profitTextClass : lossTextClass,
                      )}
                    >
                      {signal.side === 'buy' ? 'Buy' : 'Sell'}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[10px] tabular-nums text-neutral-500">
                    {signal.timestamp}
                    <span className="mx-1">·</span>
                    {signal.outcome}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={clsx('text-sm font-bold tabular-nums', pipsClass(signal.pipsTone))}>
                    {signal.pips}
                  </p>
                  <p className="text-[10px] tabular-nums text-neutral-500">{signal.duration}</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-neutral-300" aria-hidden />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
