import { useEffect, useRef } from 'react'
import { CheckCircle2, Clock, Scale, TrendingUp, X } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import type { BacktestTradeRow } from '../../lib/backtestTypes'
import {
  backtestDisplayLabels,
  computeRiskRewardRatio,
  displayOutcomeLabel,
  formatDurationMs,
  formatPipValue,
  formatSignalTimestamp,
  outcomeBannerLabel,
  outcomeBannerTone,
  tradeDurationMs,
  tradePipPnl,
} from '../../lib/backtestDisplay'
import { BacktestPriceLadder } from './BacktestPriceLadder'
import { BacktestEventTimeline } from './BacktestEventTimeline'

interface BacktestResultModalProps {
  trade: BacktestTradeRow | null
  onClose: () => void
}

export function BacktestResultModal({ trade, onClose }: BacktestResultModalProps) {
  const t = useT()
  const bt = t.backtest
  const btLabels = backtestDisplayLabels(bt)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!trade) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [trade, onClose])

  if (!trade) return null

  const pips = tradePipPnl(trade)
  const durationMs = tradeDurationMs(trade.signal_at, trade.closed_at)
  const rr = computeRiskRewardRatio(
    trade.entry_price,
    trade.sl,
    trade.tp_levels,
    trade.direction,
  )
  const banner = outcomeBannerLabel(trade.outcome, trade.tps_hit, trade.tp_levels.length, btLabels)
  const bannerTone = outcomeBannerTone(trade.outcome, pips)
  const outcomeLabel = displayOutcomeLabel(
    trade.outcome,
    trade.tps_hit,
    trade.tp_levels.length,
    btLabels.outcomes,
  )
  const pipsPositive = pips != null && pips > 0
  const pipsNegative = pips != null && pips < 0

  const bannerClass =
    bannerTone === 'success'
      ? 'bg-teal-50 border-teal-200 text-teal-800 dark:bg-teal-950/40 dark:border-teal-800 dark:text-teal-200'
      : bannerTone === 'danger'
        ? 'bg-error-50 border-error-200 text-error-800 dark:bg-error-950/40 dark:border-error-800 dark:text-error-200'
        : bannerTone === 'warning'
          ? 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200'
          : 'bg-neutral-50 border-neutral-200 text-neutral-700 dark:bg-neutral-800/50 dark:border-neutral-700'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="backtest-result-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-900/50 backdrop-blur-sm"
        aria-label={bt.close}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white/95 dark:bg-neutral-900/95 backdrop-blur">
          <h2 id="backtest-result-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {bt.resultModalTitle}
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              aria-label={bt.close}
              onClick={onClose}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-5">
          <div className={clsx('flex items-center gap-2.5 rounded-xl border px-4 py-3', bannerClass)}>
            {bannerTone === 'success' ? (
              <CheckCircle2 className="w-5 h-5 shrink-0" />
            ) : (
              <TrendingUp className="w-5 h-5 shrink-0 opacity-70" />
            )}
            <span className="font-semibold">{banner}</span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 text-center">
              <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">{bt.pips}</p>
              <p
                className={clsx(
                  'text-xl font-bold tabular-nums mt-1',
                  pipsPositive && 'text-teal-600 dark:text-teal-400',
                  pipsNegative && 'text-error-600 dark:text-error-400',
                  !pipsPositive && !pipsNegative && 'text-neutral-900 dark:text-neutral-50',
                )}
              >
                {formatPipValue(pips).replace(/p$/, '')}
              </p>
            </div>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 text-center">
              <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 flex items-center justify-center gap-1">
                <Scale className="w-3 h-3" />
                {bt.riskReward}
              </p>
              <p className="text-xl font-bold tabular-nums mt-1 text-neutral-900 dark:text-neutral-50">
                {rr}
              </p>
            </div>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 text-center">
              <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 flex items-center justify-center gap-1">
                <Clock className="w-3 h-3" />
                {bt.duration}
              </p>
              <p className="text-xl font-bold tabular-nums mt-1 text-neutral-900 dark:text-neutral-50">
                {formatDurationMs(durationMs)}
              </p>
            </div>
          </div>

          <div className="text-xs text-neutral-500 flex flex-wrap gap-x-3 gap-y-1">
            <span>{trade.symbol}</span>
            <span>·</span>
            <span className="uppercase font-medium">{trade.direction}</span>
            <span>·</span>
            <span>{outcomeLabel}</span>
            <span>·</span>
            <span className="tabular-nums">{formatSignalTimestamp(trade.signal_at)}</span>
          </div>

          <BacktestPriceLadder trade={trade} labels={btLabels} />
          <BacktestEventTimeline trade={trade} labels={btLabels} />
        </div>
      </div>
    </div>
  )
}
