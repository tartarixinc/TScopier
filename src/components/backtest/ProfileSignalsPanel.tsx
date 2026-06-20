import clsx from 'clsx'
import type { StoredBacktestSignal } from '../../lib/backtestTypes'
import { formatEntryPrice } from '../../lib/backtestDisplay'
import { lossTextClass, profitTextClass } from '../../lib/pnlDisplay'

export interface SymbolProfileRow {
  symbol: string
  count: number
}

export function buildSymbolProfiles(signals: StoredBacktestSignal[]): SymbolProfileRow[] {
  const counts = new Map<string, number>()
  for (const s of signals) {
    const sym = s.symbol.trim().toUpperCase()
    if (!sym) continue
    counts.set(sym, (counts.get(sym) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
}

interface ProfileSignalsPanelProps {
  signals: StoredBacktestSignal[]
  symbols: SymbolProfileRow[]
  selectedSymbol: string | null
  onSelectSymbol: (symbol: string) => void
  profileNote: string
}

export function ProfileSignalsPanel({
  signals,
  symbols,
  selectedSymbol,
  onSelectSymbol,
  profileNote,
}: ProfileSignalsPanelProps) {
  if (signals.length === 0) {
    return (
      <p className="text-sm text-neutral-400 py-6 text-center">
        No tradeable signals in this range. Try a wider date range or another channel.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium text-neutral-500 mb-2">Symbols ({symbols.length})</p>
        <p className="text-[11px] text-neutral-400 mb-2">
          Select a symbol to backtest against live market data.
        </p>
        <div className="flex flex-wrap gap-2">
          {symbols.map(({ symbol, count }) => (
            <button
              key={symbol}
              type="button"
              onClick={() => onSelectSymbol(symbol)}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-sm border transition-colors',
                selectedSymbol === symbol
                  ? 'border-teal-500 bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200'
                  : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-neutral-300',
              )}
            >
              {symbol}
              <span className="ml-1.5 text-xs opacity-70 tabular-nums">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {profileNote ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{profileNote}</p>
      ) : null}

      <div className="overflow-x-auto max-h-64 overflow-y-auto border border-neutral-100 dark:border-neutral-800 rounded-lg">
        <table className="w-full text-xs">
          <thead className="text-neutral-500 sticky top-0 bg-white dark:bg-neutral-900 z-10">
            <tr className="border-b border-neutral-100 dark:border-neutral-800">
              <th className="text-left py-2 px-2 font-medium">Time</th>
              <th className="text-left py-2 pr-2 font-medium">Symbol</th>
              <th className="text-left py-2 pr-2 font-medium">Side</th>
              <th className="text-right py-2 pr-2 font-medium">Entry</th>
              <th className="text-right py-2 pr-2 font-medium">SL</th>
              <th className="text-left py-2 pr-2 font-medium">TPs</th>
            </tr>
          </thead>
          <tbody>
            {signals.map(row => (
              <tr
                key={row.id}
                className={clsx(
                  'border-b border-neutral-50 dark:border-neutral-800/80',
                  selectedSymbol && row.symbol.toUpperCase() === selectedSymbol
                    ? 'bg-teal-50/50 dark:bg-teal-950/20'
                    : '',
                )}
              >
                <td className="py-1.5 px-2 whitespace-nowrap text-neutral-600 dark:text-neutral-400">
                  {new Date(row.signal_at).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td className="py-1.5 pr-2 font-medium">{row.symbol}</td>
                <td
                  className={clsx(
                    'py-1.5 pr-2 uppercase',
                    row.direction === 'buy' ? profitTextClass : lossTextClass,
                  )}
                >
                  {row.direction}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {row.entry_price > 0 ? formatEntryPrice(row.entry_price) : 'MKT'}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {row.sl != null ? formatEntryPrice(row.sl) : '—'}
                </td>
                <td className="py-1.5 pr-2 tabular-nums">
                  {(row.tp_levels ?? []).length
                    ? row.tp_levels.map(p => formatEntryPrice(p)).join(', ')
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
