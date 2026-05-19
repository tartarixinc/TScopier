import { useMemo } from 'react'
import clsx from 'clsx'
import type { BacktestTradeRow } from '../../lib/backtestTypes'
import {
  displayOutcomeLabel,
  formatDurationMs,
  formatEntryPrice,
  formatPipValue,
  formatSignalTimestamp,
  outcomeTone,
  tradeDurationMs,
  tradePipPnl,
} from '../../lib/backtestDisplay'

function formatTpLevels(levels: number[]): string {
  if (!levels.length) return '—'
  return levels.map(p => formatEntryPrice(p)).join(', ')
}

function normalizeTrade(row: BacktestTradeRow): BacktestTradeRow {
  return {
    ...row,
    lot_size: Number(row.lot_size) > 0 ? Number(row.lot_size) : 0.01,
    tp_levels: Array.isArray(row.tp_levels) ? row.tp_levels : [],
  }
}

interface BacktestResultsTableProps {
  trades: BacktestTradeRow[]
}

export function BacktestResultsTable({ trades }: BacktestResultsTableProps) {
  const rows = useMemo(
    () =>
      [...trades]
        .map(normalizeTrade)
        .sort((a, b) => new Date(b.signal_at).getTime() - new Date(a.signal_at).getTime()),
    [trades],
  )

  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-sm text-neutral-500">
        No signal results for this run.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto max-h-[min(70vh,640px)] overflow-y-auto">
      <table className="w-full text-xs sm:text-sm">
        <thead className="text-neutral-500 bg-neutral-50 dark:bg-neutral-800/60 sticky top-0">
          <tr className="border-b border-neutral-200 dark:border-neutral-700">
            <th className="text-left font-medium py-2.5 px-3 whitespace-nowrap">Time</th>
            <th className="text-left font-medium py-2.5 px-2 whitespace-nowrap">Symbol</th>
            <th className="text-left font-medium py-2.5 px-2 whitespace-nowrap">Side</th>
            <th className="text-right font-medium py-2.5 px-2 whitespace-nowrap">SL</th>
            <th className="text-left font-medium py-2.5 px-2 whitespace-nowrap">TP</th>
            <th className="text-left font-medium py-2.5 px-2 whitespace-nowrap">Result</th>
            <th className="text-right font-medium py-2.5 px-2 whitespace-nowrap">Pips</th>
            <th className="text-right font-medium py-2.5 px-3 whitespace-nowrap">Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(trade => {
            const pips = tradePipPnl(trade)
            const tone = outcomeTone(trade.outcome, pips)
            const tpCount = trade.tp_levels.length
            const outcomeLabel = displayOutcomeLabel(trade.outcome, trade.tps_hit, tpCount)
            const durationMs = tradeDurationMs(trade.signal_at, trade.closed_at)
            const isBuy = trade.direction === 'buy'
            const pipClass =
              tone === 'good'
                ? 'text-teal-600 dark:text-teal-400'
                : tone === 'bad'
                  ? 'text-error-600 dark:text-error-400'
                  : 'text-neutral-600 dark:text-neutral-400'

            return (
              <tr
                key={trade.id}
                className="border-b border-neutral-100 dark:border-neutral-800/80 hover:bg-neutral-50/80 dark:hover:bg-neutral-800/30"
              >
                <td className="py-2.5 px-3 whitespace-nowrap text-neutral-600 dark:text-neutral-400 tabular-nums">
                  {formatSignalTimestamp(trade.signal_at)}
                </td>
                <td className="py-2.5 px-2 font-medium text-neutral-900 dark:text-neutral-100">
                  {trade.symbol}
                </td>
                <td
                  className={clsx(
                    'py-2.5 px-2 uppercase font-medium',
                    isBuy ? 'text-teal-600 dark:text-teal-400' : 'text-error-600 dark:text-error-400',
                  )}
                >
                  {isBuy ? 'Buy' : 'Sell'}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                  {trade.sl != null ? formatEntryPrice(trade.sl) : '—'}
                </td>
                <td className="py-2.5 px-2 tabular-nums text-neutral-700 dark:text-neutral-300 max-w-[10rem] truncate" title={formatTpLevels(trade.tp_levels)}>
                  {formatTpLevels(trade.tp_levels)}
                </td>
                <td className="py-2.5 px-2 text-neutral-700 dark:text-neutral-300 whitespace-nowrap">
                  {outcomeLabel}
                </td>
                <td className={clsx('py-2.5 px-2 text-right tabular-nums font-semibold', pipClass)}>
                  {formatPipValue(pips)}
                </td>
                <td className="py-2.5 px-3 text-right tabular-nums text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                  {formatDurationMs(durationMs)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
