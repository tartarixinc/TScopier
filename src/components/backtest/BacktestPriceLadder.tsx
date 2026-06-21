import { useMemo } from 'react'
import { TrendingDown, TrendingUp } from 'lucide-react'
import clsx from 'clsx'
import { lossTextClass } from '../../lib/pnlDisplay'
import { useT } from '../../context/LocaleContext'
import type { BacktestTradeRow } from '../../lib/backtestTypes'
import {
  backtestDisplayLabels,
  buildPriceLevels,
  formatEntryPrice,
  type BacktestDisplayLabels,
  type PriceLevelLine,
} from '../../lib/backtestDisplay'

interface BacktestPriceLadderProps {
  trade: BacktestTradeRow
  labels?: BacktestDisplayLabels
}

function lineStyle(kind: PriceLevelLine['kind']): { line: string; text: string } {
  switch (kind) {
    case 'entry':
      return {
        line: 'border-neutral-400 dark:border-neutral-500',
        text: 'text-neutral-700 dark:text-neutral-200',
      }
    case 'sl':
      return {
        line: 'border-[#737373] border-dashed',
        text: lossTextClass,
      }
    case 'be':
      return {
        line: 'border-amber-400 border-dashed',
        text: 'text-amber-700 dark:text-amber-400',
      }
    default:
      return {
        line: 'border-teal-500',
        text: 'text-teal-700 dark:text-teal-400',
      }
  }
}

export function BacktestPriceLadder({ trade, labels: labelsProp }: BacktestPriceLadderProps) {
  const t = useT()
  const bt = t.backtest
  const labels = labelsProp ?? backtestDisplayLabels(bt)
  const isBuy = trade.direction === 'buy'
  const levels = useMemo(() => buildPriceLevels(trade, labels), [trade, labels])

  const rows = useMemo(() => {
    if (!levels.length) return []
    const prices = levels.map(l => l.price)
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    const span = max - min || 1
    return levels.map(level => ({
      ...level,
      pct: ((level.price - min) / span) * 100,
    }))
  }, [levels])

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-900/50 p-4">
      <div className="flex items-center gap-2 mb-4">
        {isBuy ? (
          <TrendingUp className="w-4 h-4 text-teal-600" />
        ) : (
          <TrendingDown className={clsx('w-4 h-4', lossTextClass)} />
        )}
        <span
          className={clsx(
            'text-sm font-semibold uppercase tracking-wide',
            isBuy ? 'text-teal-700 dark:text-teal-400' : lossTextClass,
          )}
        >
          {isBuy ? bt.buy : bt.sell}
        </span>
      </div>

      <div className="relative h-44 sm:h-48">
        {rows.map(row => {
          const style = lineStyle(row.kind)
          return (
            <div
              key={`${row.kind}-${row.label}-${row.price}`}
              className="absolute left-0 right-0 flex items-center gap-3"
              style={{ bottom: `${row.pct}%`, transform: 'translateY(50%)' }}
            >
              <div className={clsx('flex-1 border-t-2', style.line)} />
              <span className={clsx('text-xs font-medium tabular-nums shrink-0', style.text)}>
                {row.label} {formatEntryPrice(row.price)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}