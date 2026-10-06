import { useCallback, useEffect, useState } from 'react'
import { Clock, Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import { pipValueTextClass } from '../../lib/pnlDisplay'
import { interpolate } from '../../i18n/interpolate'
import { useT } from '../../context/LocaleContext'
import { supabase } from '../../lib/supabase'
import { normalizeBacktestTradeRow } from '../../lib/backtestApi'
import type { BacktestRunRow } from '../../lib/backtestTypes'
import { formatPipValue, parseSummary, sumTradePipPnl } from '../../lib/backtestDisplay'

export type BacktestHistoryRow = Pick<
  BacktestRunRow,
  'id' | 'name' | 'status' | 'summary' | 'config' | 'created_at' | 'completed_at'
>

interface BacktestHistoryModalProps {
  open: boolean
  userId: string | undefined
  channelNames: Map<string, string>
  onClose: () => void
  onSelectRun: (run: BacktestHistoryRow) => void
}

function runSymbols(config: BacktestRunRow['config']): string {
  const syms = config?.symbols
  if (Array.isArray(syms) && syms.length > 0) {
    return syms.map(String).join(', ')
  }
  return '—'
}

export function BacktestHistoryModal({
  open,
  userId,
  channelNames,
  onClose,
  onSelectRun,
}: BacktestHistoryModalProps) {
  const t = useT()
  const bt = t.backtest
  const [runs, setRuns] = useState<BacktestHistoryRow[]>([])
  const [pipsByRunId, setPipsByRunId] = useState<Record<string, number | null>>({})
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')

  const runChannelLabel = (config: BacktestRunRow['config']): string => {
    const ids = config?.channelIds
    if (!Array.isArray(ids) || ids.length === 0) return '—'
    const first = channelNames.get(String(ids[0])) ?? bt.channelFallback
    return ids.length > 1
      ? interpolate(bt.channelMore, { name: first, count: String(ids.length - 1) })
      : first
  }

  const statusBadge = (status: string): { label: string; className: string } => {
    switch (status) {
      case 'completed':
        return {
          label: bt.statusCompleted,
          className: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
        }
      case 'failed':
        return {
          label: bt.statusFailed,
          className: 'bg-error-100 text-[#737373] dark:bg-error-950 dark:text-[#737373]',
        }
      case 'running':
      case 'pending':
        return {
          label: bt.statusRunning,
          className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
        }
      case 'cancelled':
        return {
          label: bt.statusCancelled,
          className: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
        }
      default:
        return {
          label: status,
          className: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800',
        }
    }
  }

  const formatRunDate = (iso: string): string => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const fetchHistory = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    setLoadError('')
    try {
      const { data, error } = await supabase
        .from('backtest_runs')
        .select('id, name, status, summary, config, created_at, completed_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw new Error(error.message)
      const historyRows = (data ?? []) as BacktestHistoryRow[]
      setRuns(historyRows)

      const runIds = historyRows.map(r => r.id)
      if (runIds.length === 0) {
        setPipsByRunId({})
        return
      }

      // Recompute trader-pip totals from trade levels so gold history is not stuck on
      // old cent-point summary.totalPips (1 pip = 0.01).
      const { data: tradeRows, error: tradeErr } = await supabase
        .from('backtest_trades')
        .select('id, run_id, symbol, direction, signal_at, entry_price, exit_price, sl, tp_levels, outcome, tps_hit, pnl, lot_size, details')
        .in('run_id', runIds)
      if (tradeErr) throw new Error(tradeErr.message)

      const byRun = new Map<string, ReturnType<typeof normalizeBacktestTradeRow>[]>()
      for (const raw of tradeRows ?? []) {
        const runId = String((raw as { run_id?: string }).run_id ?? '')
        if (!runId) continue
        const list = byRun.get(runId) ?? []
        list.push(normalizeBacktestTradeRow(raw as Record<string, unknown>))
        byRun.set(runId, list)
      }

      const next: Record<string, number | null> = {}
      for (const run of historyRows) {
        const trades = byRun.get(run.id)
        if (trades && trades.length > 0) {
          next[run.id] = sumTradePipPnl(trades)
        } else {
          const summary = parseSummary(run.summary)
          next[run.id] = summary?.totalPips != null && Number.isFinite(summary.totalPips)
            ? summary.totalPips
            : null
        }
      }
      setPipsByRunId(next)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setRuns([])
      setPipsByRunId({})
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    if (!open) return
    void fetchHistory()
  }, [open, fetchHistory])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="backtest-history-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={bt.close}
        onClick={onClose}
      />
      <div className="relative w-full sm:max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-neutral-200/65 dark:border-neutral-800/55 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 shrink-0">
          <div>
            <h2 id="backtest-history-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              {bt.historyModalTitle}
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">{bt.historyModalSubtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            aria-label={bt.close}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-neutral-500">
              <Loader2 className="w-5 h-5 animate-spin" />
              {t.common.loading}
            </div>
          ) : loadError ? (
            <p className="text-sm text-error-600 px-5 py-8">{loadError}</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-neutral-500 text-center py-16 px-5">
              {bt.historyEmpty}
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {runs.map(run => {
                const badge = statusBadge(run.status)
                const pips = pipsByRunId[run.id]
                const cfg = run.config as BacktestRunRow['config']
                const dateRange =
                  cfg?.dateFrom && cfg?.dateTo ? `${cfg.dateFrom} → ${cfg.dateTo}` : '—'

                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => onSelectRun(run)}
                      className="w-full text-left px-5 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-neutral-900 dark:text-neutral-100 truncate">
                            {runSymbols(cfg)}
                          </p>
                          <p className="text-xs text-neutral-500 mt-0.5">
                            {runChannelLabel(cfg)}
                            <span className="mx-1.5">·</span>
                            {dateRange}
                          </p>
                          <p className="text-xs text-neutral-400 mt-1 flex items-center gap-1 tabular-nums">
                            <Clock className="w-3 h-3 shrink-0" />
                            {formatRunDate(run.created_at)}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1.5 shrink-0">
                          <span className={clsx('text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full', badge.className)}>
                            {badge.label}
                          </span>
                          {pips != null && Number.isFinite(pips) ? (
                            <span
                              className={clsx(
                                'text-sm font-bold tabular-nums',
                                pipValueTextClass(pips),
                              )}
                            >
                              {formatPipValue(pips)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
