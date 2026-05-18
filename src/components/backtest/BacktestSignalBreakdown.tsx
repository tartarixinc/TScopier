import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, TrendingDown, TrendingUp } from 'lucide-react'
import clsx from 'clsx'
import type { BacktestTradeRow } from '../../lib/backtestTypes'
import {
  displayOutcomeLabel,
  formatDurationMs,
  formatEntryPrice,
  formatPipValue,
  formatSignalTimestamp,
  monthGroupKey,
  monthGroupLabel,
  outcomeTone,
  tradeDurationMs,
  tradePipPnl,
} from '../../lib/backtestDisplay'

const OUTCOME_DETAIL: Record<string, string> = {
  sl_before_tp: 'Stop loss hit before any take profit',
  tp1_then_sl: 'First take profit hit, then stopped out',
  tp_then_be: 'Take profit hit, remainder closed at breakeven',
  all_tp_hit: 'All take profit levels reached',
  breakeven: 'Closed at breakeven',
  no_data: 'No market data for this window',
  skipped: 'Signal skipped (missing SL/TP or invalid)',
  open: 'Still open at end of data',
}

interface MonthGroup {
  key: string
  label: string
  trades: BacktestTradeRow[]
  wins: number
  losses: number
  totalPips: number
}

interface BacktestSignalBreakdownProps {
  trades: BacktestTradeRow[]
  channelNames: Record<string, string>
}

function normalizeTrade(row: BacktestTradeRow): BacktestTradeRow {
  return {
    ...row,
    lot_size: Number(row.lot_size) > 0 ? Number(row.lot_size) : 0.01,
    tp_levels: Array.isArray(row.tp_levels) ? row.tp_levels : [],
    pnl_r: row.pnl_r != null ? Number(row.pnl_r) : null,
  }
}

function buildMonthGroups(trades: BacktestTradeRow[]): MonthGroup[] {
  const byMonth = new Map<string, BacktestTradeRow[]>()
  const sorted = [...trades].sort(
    (a, b) => new Date(b.signal_at).getTime() - new Date(a.signal_at).getTime(),
  )
  for (const t of sorted) {
    const key = monthGroupKey(t.signal_at)
    const list = byMonth.get(key) ?? []
    list.push(t)
    byMonth.set(key, list)
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, monthTrades]) => {
      let wins = 0
      let losses = 0
      let totalPips = 0
      for (const t of monthTrades) {
        const pips = tradePipPnl(t)
        if (pips == null) continue
        totalPips += pips
        if (pips > 0) wins += 1
        else if (pips < 0) losses += 1
      }
      return {
        key,
        label: monthGroupLabel(key),
        trades: monthTrades,
        wins,
        losses,
        totalPips,
      }
    })
}

export function BacktestSignalBreakdown({ trades, channelNames }: BacktestSignalBreakdownProps) {
  const normalized = useMemo(() => trades.map(normalizeTrade), [trades])
  const groups = useMemo(() => buildMonthGroups(normalized), [normalized])

  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => new Set())
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null)

  const isMonthExpanded = (key: string) =>
    expandedMonths.size === 0 ? true : expandedMonths.has(key)

  const toggleMonth = (key: string) => {
    setExpandedMonths(prev => {
      const allExpanded = prev.size === 0
      const next = allExpanded ? new Set(groups.map(g => g.key)) : new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (groups.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-sm text-neutral-500">No simulated signals in this run.</p>
    )
  }

  return (
    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {groups.map(group => {
        const open = isMonthExpanded(group.key)
        const totalLabel = formatPipValue(group.totalPips)
        const totalTone = group.totalPips >= 0 ? 'text-teal-600 dark:text-teal-400' : 'text-error-600 dark:text-error-400'

        return (
          <section key={group.key}>
            <button
              type="button"
              onClick={() => toggleMonth(group.key)}
              className="flex w-full items-center gap-3 bg-neutral-50/80 px-4 py-3 text-left transition-colors hover:bg-neutral-100/80 dark:bg-neutral-800/40 dark:hover:bg-neutral-800/70 sm:px-5"
            >
              {open ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
              )}
              <div className="min-w-0 flex-1">
                <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{group.label}</span>
                <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                  {group.trades.length} signal{group.trades.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums">
                <span className="text-neutral-500 dark:text-neutral-400">
                  {group.wins}W / {group.losses}L
                </span>
                <span className={clsx('font-semibold', totalTone)}>{totalLabel}</span>
              </div>
            </button>

            {open ? (
              <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {group.trades.map(trade => (
                  <SignalRow
                    key={trade.id}
                    trade={trade}
                    channelName={
                      (trade.channel_id && channelNames[trade.channel_id])
                      || channelNames[trade.channel_id ?? '']
                      || 'Channel'
                    }
                    expanded={expandedTradeId === trade.id}
                    onToggle={() =>
                      setExpandedTradeId(id => (id === trade.id ? null : trade.id))
                    }
                  />
                ))}
              </ul>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

function SignalRow({
  trade,
  channelName,
  expanded,
  onToggle,
}: {
  trade: BacktestTradeRow
  channelName: string
  expanded: boolean
  onToggle: () => void
}) {
  const isBuy = trade.direction === 'buy'
  const pips = tradePipPnl(trade)
  const tone = outcomeTone(trade.outcome, pips)
  const tpCount = trade.tp_levels.length
  const outcomeLabel = displayOutcomeLabel(trade.outcome, trade.tps_hit, tpCount)
  const durationMs = tradeDurationMs(trade.signal_at, trade.closed_at)
  const tpEvents = Array.isArray(trade.details?.tpEvents)
    ? trade.details!.tpEvents!
    : []

  const pipClass =
    tone === 'good'
      ? 'text-teal-600 dark:text-teal-400'
      : tone === 'bad'
        ? 'text-error-600 dark:text-error-400'
        : 'text-neutral-500 dark:text-neutral-400'

  const badgeClass =
    tone === 'good'
      ? 'border-teal-200 text-teal-700 dark:border-teal-800 dark:text-teal-300'
      : tone === 'bad'
        ? 'border-error-200 text-error-700 dark:border-error-900 dark:text-error-300'
        : 'border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400'

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-neutral-50/80 dark:hover:bg-neutral-800/40 sm:gap-4 sm:px-5"
      >
        <div
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            isBuy
              ? 'bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-400'
              : 'bg-error-50 text-error-600 dark:bg-error-950/40 dark:text-error-400',
          )}
        >
          {isBuy ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400 truncate">{channelName}</p>
          <p className="mt-0.5 text-sm leading-snug">
            <span className="font-semibold text-neutral-900 dark:text-neutral-50">{trade.symbol}</span>
            {' '}
            <span
              className={clsx(
                'font-semibold uppercase',
                isBuy ? 'text-teal-600 dark:text-teal-400' : 'text-error-600 dark:text-error-400',
              )}
            >
              {isBuy ? 'BUY' : 'SELL'}
            </span>
            <span className="text-neutral-400 dark:text-neutral-500">
              {' '}@ {formatEntryPrice(trade.entry_price)}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-neutral-400 dark:text-neutral-500">
            {formatSignalTimestamp(trade.signal_at)}
            {tpCount > 0 ? ` · ${tpCount} TP${tpCount === 1 ? '' : 's'}` : null}
            {trade.tps_hit > 0 ? ` · ${trade.tps_hit} hit` : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <span
            className={clsx(
              'hidden rounded-full border px-2 py-0.5 text-[10px] font-medium sm:inline',
              badgeClass,
            )}
          >
            {outcomeLabel}
          </span>
          <span className={clsx('text-sm font-semibold tabular-nums', pipClass)}>
            {formatPipValue(pips)}
          </span>
          <ChevronRight
            className={clsx(
              'h-4 w-4 text-neutral-300 transition-transform dark:text-neutral-600',
              expanded && 'rotate-90',
            )}
          />
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-neutral-100 bg-neutral-50/50 px-4 py-4 text-xs dark:border-neutral-800 dark:bg-neutral-800/30 sm:px-5 sm:pl-[4.25rem]">
          <div className="mb-3 rounded-lg border border-teal-200 bg-teal-50/80 px-3 py-2 font-medium text-teal-800 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-200">
            {outcomeLabel === 'All TPs' ? 'All TPs Hit' : outcomeLabel}
          </div>
          <div className="grid gap-2 sm:grid-cols-3 mb-4">
            <Detail label="Pips" value={formatPipValue(pips)} />
            <Detail
              label="R:R ratio"
              value={trade.pnl_r != null ? `1:${Math.abs(trade.pnl_r).toFixed(1)}` : '—'}
            />
            <Detail label="Duration" value={formatDurationMs(durationMs)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 mb-4">
            <Detail label="Outcome" value={OUTCOME_DETAIL[trade.outcome] ?? outcomeLabel} />
            <Detail
              label="Exit"
              value={trade.exit_price != null ? formatEntryPrice(trade.exit_price) : '—'}
            />
            {trade.sl != null ? (
              <Detail label="Stop loss" value={formatEntryPrice(trade.sl)} />
            ) : null}
          </div>
          {tpEvents.length > 0 ? (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 mb-2">
                Event timeline
              </p>
              <ul className="space-y-2 border-l-2 border-neutral-200 dark:border-neutral-700 pl-3">
                {tpEvents.map((ev) => (
                  <li key={ev.index} className="relative">
                    <span className="absolute -left-[1.15rem] top-1 h-2 w-2 rounded-full bg-teal-500" />
                    <p className="font-medium text-teal-700 dark:text-teal-300">
                      TP{ev.index} Hit → {formatEntryPrice(ev.price)}
                    </p>
                    <p className="text-neutral-500 dark:text-neutral-400">
                      {new Date(ev.ts).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function Detail({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className={className}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-0.5 text-neutral-700 dark:text-neutral-300">{value}</p>
    </div>
  )
}
