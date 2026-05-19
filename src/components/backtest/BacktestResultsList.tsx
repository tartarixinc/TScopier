import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { interpolate } from '../../i18n/interpolate'
import { useT } from '../../context/LocaleContext'
import type { BacktestTradeRow } from '../../lib/backtestTypes'
import {
  backtestDisplayLabels,
  displayOutcomeLabel,
  formatDurationMs,
  formatPipValue,
  formatSignalTimestamp,
  outcomeTone,
  tradeDurationMs,
  tradePipPnl,
} from '../../lib/backtestDisplay'

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number]

interface BacktestResultsListProps {
  trades: BacktestTradeRow[]
  onSelect: (trade: BacktestTradeRow) => void
}

function PageButton({
  n,
  active,
  onClick,
}: {
  n: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'min-w-[2rem] h-8 px-2 text-sm rounded-md border tabular-nums transition-colors',
        active
          ? 'border-teal-500 bg-teal-500 text-white'
          : 'border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-white dark:hover:bg-neutral-900',
      )}
      aria-current={active ? 'page' : undefined}
    >
      {n}
    </button>
  )
}

export function BacktestResultsList({ trades, onSelect }: BacktestResultsListProps) {
  const t = useT()
  const bt = t.backtest
  const btLabels = backtestDisplayLabels(bt)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSizeOption>(10)

  const rows = useMemo(
    () =>
      [...trades].sort(
        (a, b) => new Date(b.signal_at).getTime() - new Date(a.signal_at).getTime(),
      ),
    [trades],
  )

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))

  useEffect(() => {
    setPage(1)
  }, [trades, pageSize])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const pageRows = useMemo(() => {
    const start = (page - 1) * pageSize
    return rows.slice(start, start + pageSize)
  }, [rows, page, pageSize])

  const rangeStart = rows.length === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = Math.min(page * pageSize, rows.length)

  const pageNumbers = useMemo(() => {
    const maxButtons = 5
    if (totalPages <= maxButtons) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }
    let start = Math.max(1, page - 2)
    let end = Math.min(totalPages, start + maxButtons - 1)
    start = Math.max(1, end - maxButtons + 1)
    return Array.from({ length: end - start + 1 }, (_, i) => start + i)
  }, [page, totalPages])

  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-500 py-12 text-center">
        No signal results for this run.
      </p>
    )
  }

  return (
    <div>
      <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
        {pageRows.map(trade => {
          const pips = tradePipPnl(trade)
          const tone = outcomeTone(trade.outcome, pips)
          const durationMs = tradeDurationMs(trade.signal_at, trade.closed_at)
          const outcomeLabel = displayOutcomeLabel(
            trade.outcome,
            trade.tps_hit,
            trade.tp_levels.length,
            btLabels.outcomes,
          )
          const isBuy = trade.direction === 'buy'

          return (
            <li key={trade.id}>
              <button
                type="button"
                onClick={() => onSelect(trade)}
                className="w-full flex items-center gap-4 px-4 sm:px-5 py-4 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors group"
              >
                <div
                  className={clsx(
                    'w-1 self-stretch rounded-full shrink-0 min-h-[3rem]',
                    tone === 'good' && 'bg-teal-500',
                    tone === 'bad' && 'bg-error-500',
                    tone === 'neutral' && 'bg-neutral-300 dark:bg-neutral-600',
                  )}
                />
                <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-1 sm:gap-4 sm:items-center">
                  <div>
                    <p className="font-medium text-neutral-900 dark:text-neutral-100">
                      {trade.symbol}
                      <span
                        className={clsx(
                          'ml-2 text-xs uppercase font-semibold',
                          isBuy ? 'text-teal-600' : 'text-error-600',
                        )}
                      >
                        {isBuy ? 'Buy' : 'Sell'}
                      </span>
                    </p>
                    <p className="text-xs text-neutral-500 mt-0.5 tabular-nums">
                      {formatSignalTimestamp(trade.signal_at)}
                      <span className="mx-1.5">·</span>
                      {outcomeLabel}
                    </p>
                  </div>
                  <p
                    className={clsx(
                      'text-lg font-bold tabular-nums sm:text-right',
                      tone === 'good' && 'text-teal-600 dark:text-teal-400',
                      tone === 'bad' && 'text-error-600 dark:text-error-400',
                      tone === 'neutral' && 'text-neutral-600',
                    )}
                  >
                    {formatPipValue(pips)}
                  </p>
                  <p className="text-xs text-neutral-500 tabular-nums sm:text-right">
                    {formatDurationMs(durationMs)}
                  </p>
                </div>
                <ChevronRight className="w-5 h-5 text-neutral-300 group-hover:text-teal-500 shrink-0 transition-colors" />
              </button>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-col gap-3 px-4 sm:px-5 py-3 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-800/30 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="inline-flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
            <span className="font-medium text-neutral-700 dark:text-neutral-300">{t.common.show}</span>
            <select
              value={pageSize}
              onChange={e => setPageSize(Number(e.target.value) as PageSizeOption)}
              className="h-8 min-w-[4.5rem] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-500"
              aria-label={bt.resultsPerPage}
            >
              {PAGE_SIZE_OPTIONS.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>{t.common.perPage}</span>
          </label>
          <p className="text-xs text-neutral-500 tabular-nums">
            {interpolate(t.common.showingRange, {
              start: String(rangeStart),
              end: String(rangeEnd),
              total: String(rows.length),
            })}
          </p>
        </div>
        {totalPages > 1 ? (
          <div className="flex flex-wrap items-center gap-1 justify-center sm:justify-end">
            <button
              type="button"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 disabled:opacity-40 disabled:pointer-events-none hover:bg-white dark:hover:bg-neutral-900"
              aria-label={t.common.previous}
            >
              <ChevronLeft className="w-4 h-4" />
              <span className="hidden sm:inline">{t.common.previous}</span>
            </button>
            <div className="flex items-center gap-0.5">
              {pageNumbers[0]! > 1 ? (
                <>
                  <PageButton n={1} active={page === 1} onClick={() => setPage(1)} />
                  {pageNumbers[0]! > 2 ? (
                    <span className="px-1 text-neutral-400 text-sm">…</span>
                  ) : null}
                </>
              ) : null}
              {pageNumbers.map(n => (
                <PageButton key={n} n={n} active={page === n} onClick={() => setPage(n)} />
              ))}
              {pageNumbers[pageNumbers.length - 1]! < totalPages ? (
                <>
                  {pageNumbers[pageNumbers.length - 1]! < totalPages - 1 ? (
                    <span className="px-1 text-neutral-400 text-sm">…</span>
                  ) : null}
                  <PageButton
                    n={totalPages}
                    active={page === totalPages}
                    onClick={() => setPage(totalPages)}
                  />
                </>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 disabled:opacity-40 disabled:pointer-events-none hover:bg-white dark:hover:bg-neutral-900"
              aria-label={t.common.next}
            >
              <span className="hidden sm:inline">{t.common.next}</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
