import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock, Loader2, Pencil, Scale, Trash2, TrendingUp, X } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { backtestApi } from '../../lib/backtestApi'
import type { BacktestRunRow, BacktestTradeRow } from '../../lib/backtestTypes'
import {
  backtestDisplayLabels,
  computeRiskRewardRatio,
  displayOutcomeLabel,
  formatDurationMs,
  formatEntryPrice,
  formatPipValue,
  formatSignalTimestamp,
  outcomeBannerLabel,
  outcomeBannerTone,
  tradeDurationMs,
  tradePipPnl,
} from '../../lib/backtestDisplay'
import {
  lossBannerClass,
  pipValueTextClass,
} from '../../lib/pnlDisplay'
import { BacktestEditSignalModal } from './BacktestEditSignalModal'
import { BacktestTradeReplayChart } from './BacktestTradeReplayChart'
import { BacktestEventTimeline } from './BacktestEventTimeline'

interface BacktestResultModalProps {
  trade: BacktestTradeRow | null
  onClose: () => void
  onTradeUpdated: (trade: BacktestTradeRow, run: BacktestRunRow | null) => void
  onTradeDeleted: (tradeId: string, run: BacktestRunRow | null) => void
}

export function BacktestResultModal({
  trade,
  onClose,
  onTradeUpdated,
  onTradeDeleted,
}: BacktestResultModalProps) {
  const t = useT()
  const bt = t.backtest
  const btLabels = backtestDisplayLabels(bt)
  const panelRef = useRef<HTMLDivElement>(null)
  const [displayTrade, setDisplayTrade] = useState<BacktestTradeRow | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    if (!trade) {
      setDisplayTrade(null)
      setEditOpen(false)
      setFormError('')
      return
    }
    setDisplayTrade(trade)
    setFormError('')
  }, [trade])

  useEffect(() => {
    if (!trade) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !editOpen) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [trade, onClose, busy, editOpen])

  if (!trade || !displayTrade) return null

  const pips = tradePipPnl(displayTrade)
  const durationMs = tradeDurationMs(displayTrade.signal_at, displayTrade.closed_at)
  const rr = computeRiskRewardRatio(
    displayTrade.entry_price,
    displayTrade.sl,
    displayTrade.tp_levels,
    displayTrade.direction,
  )
  const banner = outcomeBannerLabel(
    displayTrade.outcome,
    displayTrade.tps_hit,
    displayTrade.tp_levels.length,
    btLabels,
  )
  const bannerTone = outcomeBannerTone(displayTrade.outcome, pips)
  const outcomeLabel = displayOutcomeLabel(
    displayTrade.outcome,
    displayTrade.tps_hit,
    displayTrade.tp_levels.length,
    btLabels.outcomes,
  )
  const bannerClass =
    bannerTone === 'success'
      ? 'bg-teal-50 border-teal-200 text-teal-800 dark:bg-teal-950/40 dark:border-teal-800 dark:text-teal-200'
      : bannerTone === 'danger'
        ? lossBannerClass
        : bannerTone === 'warning'
          ? 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200'
          : 'bg-neutral-50 border-neutral-200 text-neutral-700 dark:bg-neutral-800/50 dark:border-neutral-700'

  const handleDelete = async () => {
    if (!window.confirm(bt.deleteConfirm)) return
    setFormError('')
    setBusy(true)
    try {
      const { run } = await backtestApi.deleteTrade(trade.id)
      onTradeDeleted(trade.id, run)
      onClose()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : bt.deleteFailed)
      setBusy(false)
    }
  }

  const handleTradeUpdated = (updated: BacktestTradeRow, run: BacktestRunRow | null) => {
    backtestApi.clearTradeReplayCache(trade.id)
    setDisplayTrade(updated)
    onTradeUpdated(updated, run)
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backtest-result-title"
      >
        <button
          type="button"
          className="absolute inset-0 bg-neutral-950/55"
          aria-label={bt.close}
          onClick={onClose}
          disabled={busy}
        />
        <div
          ref={panelRef}
          className="relative w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl"
        >
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <h2 id="backtest-result-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              {bt.resultModalTitle}
            </h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={busy}
                className="p-2 rounded-lg text-neutral-400 hover:text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-950/40 transition-colors disabled:opacity-40"
                aria-label={bt.editSignal}
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="w-5 h-5" />
              </button>
              <button
                type="button"
                disabled={busy}
                className="p-2 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 dark:hover:bg-error-950/40 transition-colors disabled:opacity-40"
                aria-label={bt.deleteResult}
                onClick={() => { void handleDelete() }}
              >
                {busy ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Trash2 className="w-5 h-5" />
                )}
              </button>
              <button
                type="button"
                className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40"
                aria-label={bt.close}
                onClick={onClose}
                disabled={busy}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="p-5 space-y-5">
            {formError ? (
              <p className="text-xs text-error-600 dark:text-error-400">{formError}</p>
            ) : null}

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
                <p className={clsx('text-xl font-bold tabular-nums mt-1', pipValueTextClass(pips))}>
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
              <span>{displayTrade.symbol}</span>
              <span>·</span>
              <span className="uppercase font-medium">{displayTrade.direction}</span>
              <span>·</span>
              <span>{outcomeLabel}</span>
              <span>·</span>
              <span className="tabular-nums">@ {formatEntryPrice(displayTrade.entry_price)}</span>
              <span>·</span>
              <span className="tabular-nums">{formatSignalTimestamp(displayTrade.signal_at)}</span>
            </div>

            <BacktestTradeReplayChart key={displayTrade.id} trade={displayTrade} />
            <BacktestEventTimeline trade={displayTrade} labels={btLabels} />
          </div>
        </div>
      </div>

      {editOpen ? (
        <BacktestEditSignalModal
          trade={displayTrade}
          onClose={() => setEditOpen(false)}
          onTradeUpdated={handleTradeUpdated}
        />
      ) : null}
    </>
  )
}
