import { useMemo, useState, type ReactNode } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatAccountAmount } from '../../lib/providerApplication'
import type { ProviderPublicPerformance as Performance, ProviderPublicTrade } from '../../lib/providerPublicProfile'
import { computePublicTradeStats, formatHolding } from '../../lib/providerPublicStats'

const DASH = '\u2014'
const STALE_AFTER_MS = 15 * 60_000
const CLOSED_TRADES_PAGE_SIZE = 10

function Metric({ label, children, tone }: { label: string; children: ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <dt className="text-xs text-neutral-600 dark:text-neutral-400">{label}</dt>
      <dd className={`mt-1 text-base font-semibold ${tone === 'up' ? 'text-green-600 dark:text-teal-300' : tone === 'down' ? 'text-red-600 dark:text-red-400' : 'text-neutral-900 dark:text-neutral-50'}`}>
        {children}
      </dd>
    </div>
  )
}

const toneFor = (value: number | null): 'up' | 'down' | undefined => value == null || value === 0 ? undefined : value > 0 ? 'up' : 'down'
const when = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : DASH
const whenTime = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : DASH
const percent = (value: number | null) => value == null ? DASH : `${value.toFixed(2)}%`

export function ProviderPublicPerformance({
  performance,
  trades,
  tradesError,
  openPnl = null,
}: {
  performance: Performance
  trades: ProviderPublicTrade[]
  tradesError: string | null
  /** Floating P/L of open trades (account equity minus balance), when known. */
  openPnl?: number | null
}) {
  const [now] = useState(() => Date.now())
  const currency = performance.currency
  const money = (value: number | null) => value == null ? DASH : formatAccountAmount(value, currency)
  const syncedAt = performance.lastSyncedAt ? Date.parse(performance.lastSyncedAt) : null
  const stale = syncedAt == null || now - syncedAt > STALE_AFTER_MS
  const months = performance.monthly.map(item => ({ ...item, label: item.month }))
  const stats = useMemo(() => computePublicTradeStats(trades), [trades])
  const openTrades = trades.filter(trade => trade.status === 'open')
  const closedTrades = trades.filter(trade => trade.status === 'closed')
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(closedTrades.length / CLOSED_TRADES_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageStart = currentPage * CLOSED_TRADES_PAGE_SIZE
  const pageTrades = closedTrades.slice(pageStart, pageStart + CLOSED_TRADES_PAGE_SIZE)
  const truncated = performance.closedCount != null && stats.closedTrades < performance.closedCount

  return (
    <>
      <section className="space-y-3" aria-label="Performance">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Performance</h2>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {syncedAt == null ? 'Not synced yet' : `${stale ? 'Last synced' : 'Updated'} ${whenTime(performance.lastSyncedAt)}`}
            {!performance.historyComplete && syncedAt != null ? ' · Partial history' : ''}
          </p>
        </div>
        {stale && syncedAt != null && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            This data was last synced a while ago and may not reflect the provider's current trades.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Metric label="Win rate">{percent(performance.winRate)}</Metric>
          <Metric label="Profit factor">{performance.profitFactor == null ? DASH : performance.profitFactor.toFixed(2)}</Metric>
          <Metric label={performance.depositSource === 'broker_history' ? 'Total deposits' : 'Starting deposit'}>
            {money(performance.deposits)}
            {performance.withdrawals != null && performance.withdrawals > 0 ? (
              <span className="block text-xs font-normal text-neutral-600 dark:text-neutral-400">Withdrawn {money(performance.withdrawals)}</span>
            ) : null}
          </Metric>
          <Metric label="ROI" tone={toneFor(performance.returnPercentage)}>{percent(performance.returnPercentage)}</Metric>
          <Metric label="Max drawdown" tone={performance.maxDrawdown ? 'down' : undefined}>{percent(performance.maxDrawdown)}</Metric>
          <Metric label="Realized P/L" tone={toneFor(performance.realizedProfit)}>{money(performance.realizedProfit)}</Metric>
          <Metric label="Closed trades">{performance.closedCount == null ? DASH : performance.closedCount.toLocaleString()}</Metric>
          <Metric label="Open trades" tone={performance.openCount ? toneFor(openPnl) : undefined}>
            {performance.openCount == null ? DASH : performance.openCount.toLocaleString()}
            {performance.openCount ? (
              <span className="block text-xs font-normal text-neutral-600 dark:text-neutral-400">Open P/L {money(openPnl)}</span>
            ) : null}
          </Metric>
          <Metric label="History period">
            <span className="text-sm">{performance.periodStart && performance.periodEnd ? `${when(performance.periodStart)} – ${when(performance.periodEnd)}` : DASH}</span>
          </Metric>
          <Metric label="Best trade" tone={toneFor(performance.bestProfit)}>
            {money(performance.bestProfit)}
            {performance.bestAt && <span className="block text-xs font-normal text-neutral-600 dark:text-neutral-400">{when(performance.bestAt)}</span>}
          </Metric>
          <Metric label="Worst trade" tone={toneFor(performance.worstProfit)}>
            {money(performance.worstProfit)}
            {performance.worstAt && <span className="block text-xs font-normal text-neutral-600 dark:text-neutral-400">{when(performance.worstAt)}</span>}
          </Metric>
        </dl>
      </section>

      {stats.closedTrades > 0 && (
        <section className="space-y-3" aria-label="Trading detail">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Trading detail</h2>
            {truncated && (
              <p className="text-xs text-neutral-600 dark:text-neutral-400">Based on the latest {stats.closedTrades} closed trades</p>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label="Winning / losing trades">{stats.wins} / {stats.losses}</Metric>
            <Metric label="Average trade" tone={toneFor(stats.avgProfit)}>{money(stats.avgProfit)}</Metric>
            <Metric label="Average holding time">{formatHolding(stats.avgHoldingHours)}</Metric>
            <Metric label="Average win" tone="up">{money(stats.avgWin)}</Metric>
            <Metric label="Average loss" tone={stats.avgLoss == null ? undefined : 'down'}>{money(stats.avgLoss)}</Metric>
            <Metric label="Longest win / loss streak">{stats.bestStreak} / {stats.worstStreak}</Metric>
            <Metric label="Buy trades">
              {stats.longTrades}
              <span className="block text-xs font-normal text-neutral-600 dark:text-neutral-400">Win rate {percent(stats.longWinRate)}</span>
            </Metric>
            <Metric label="Sell trades">
              {stats.shortTrades}
              <span className="block text-xs font-normal text-neutral-600 dark:text-neutral-400">Win rate {percent(stats.shortWinRate)}</span>
            </Metric>
            <Metric label="Gross profit / loss">
              <span className="text-sm">{money(performance.grossProfit)} / {money(performance.grossLoss == null ? null : -performance.grossLoss)}</span>
            </Metric>
          </dl>
        </section>
      )}

      {stats.curve.length > 1 && (
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900" aria-label="Cumulative profit and loss">
          <h2 className="mb-3 text-sm font-semibold">Cumulative P/L</h2>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.curve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="provider-public-cumulative" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4ade80" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#4ade80" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" strokeOpacity={0.12} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} fontSize={11} width={56} />
                <Tooltip formatter={(value) => [money(Number(value)), 'Cumulative P/L']} />
                <Area type="monotone" dataKey="cumulative" stroke="#22c55e" strokeWidth={2} fill="url(#provider-public-cumulative)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {months.length > 0 && (
        <section className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900" aria-label="Monthly profit and loss">
          <h2 className="mb-3 text-sm font-semibold">Monthly P/L</h2>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={months} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" strokeOpacity={0.12} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                <YAxis tickLine={false} axisLine={false} fontSize={11} width={56} />
                <Tooltip
                  formatter={(value) => [money(Number(value)), 'P/L']}
                  labelFormatter={(label) => String(label)}
                />
                <Bar dataKey="profit" radius={[4, 4, 0, 0]}>
                  {months.map(item => <Cell key={item.month} fill={item.profit >= 0 ? '#4ade80' : '#ef4444'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {stats.symbols.length > 0 && (
        <section className="rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900" aria-label="Instruments traded">
          <h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold dark:border-neutral-800">Instruments traded</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] text-left text-sm">
              <thead className="text-xs text-neutral-600 dark:text-neutral-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-2 py-2 font-medium">Trades</th>
                  <th className="px-2 py-2 font-medium">Win rate</th>
                  <th className="px-4 py-2 text-right font-medium">P/L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {stats.symbols.slice(0, 10).map(row => (
                  <tr key={row.symbol}>
                    <td className="px-4 py-2 font-medium">{row.symbol}</td>
                    <td className="px-2 py-2">{row.trades}</td>
                    <td className="px-2 py-2">{percent(row.winRate)}</td>
                    <td className={`px-4 py-2 text-right font-medium ${row.profit >= 0 ? 'text-green-600 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>{money(row.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {openTrades.length > 0 && (
        <section className="rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900" aria-label="Open positions">
          <h2 className="flex items-baseline justify-between gap-2 border-b border-neutral-100 px-4 py-3 text-sm font-semibold dark:border-neutral-800">
            <span>Open positions ({openTrades.length})</span>
            <span className={`text-xs font-medium ${openPnl == null || openPnl === 0 ? 'text-neutral-600 dark:text-neutral-400' : openPnl > 0 ? 'text-green-600 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>Open P/L {money(openPnl)}</span>
          </h2>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {openTrades.map(trade => (
              <li key={trade.tradeId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="font-medium">{trade.symbol}</span>
                <span className={`text-xs font-semibold uppercase ${trade.direction === 'buy' ? 'text-green-600 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>{trade.direction}</span>
                <span className="text-neutral-600 dark:text-neutral-400">Opened {whenTime(trade.openedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900" aria-label="Trade history">
        <h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold dark:border-neutral-800">Closed trades{truncated ? ` (latest ${closedTrades.length})` : ` (${closedTrades.length})`}</h2>
        {tradesError ? (
          <p role="alert" className="px-4 py-3 text-sm text-error-600">{tradesError}</p>
        ) : closedTrades.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-600 dark:text-neutral-400">No trades to show yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="text-xs text-neutral-600 dark:text-neutral-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-2 py-2 font-medium">Side</th>
                  <th className="px-2 py-2 font-medium">Opened</th>
                  <th className="px-2 py-2 font-medium">Closed</th>
                  <th className="px-4 py-2 text-right font-medium">P/L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {pageTrades.map(trade => (
                  <tr key={trade.tradeId}>
                    <td className="px-4 py-2 font-medium">{trade.symbol}</td>
                    <td className={`px-2 py-2 text-xs font-semibold uppercase ${trade.direction === 'buy' ? 'text-green-600 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>{trade.direction}</td>
                    <td className="px-2 py-2">{whenTime(trade.openedAt)}</td>
                    <td className="px-2 py-2">{trade.status === 'open' ? 'Open' : whenTime(trade.closedAt)}</td>
                    <td className={`px-4 py-2 text-right font-medium ${trade.realizedProfit == null ? '' : trade.realizedProfit >= 0 ? 'text-green-600 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>
                      {trade.status === 'open' ? DASH : money(trade.realizedProfit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!tradesError && closedTrades.length > CLOSED_TRADES_PAGE_SIZE && (
          <nav className="flex items-center justify-between gap-3 border-t border-neutral-100 px-4 py-3 text-xs dark:border-neutral-800" aria-label="Closed trades pages">
            <p className="text-neutral-600 dark:text-neutral-400">
              {pageStart + 1}&ndash;{Math.min(pageStart + CLOSED_TRADES_PAGE_SIZE, closedTrades.length)} of {closedTrades.length}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(Math.max(0, currentPage - 1))}
                disabled={currentPage === 0}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700"
              >
                Previous
              </button>
              <span className="text-neutral-600 dark:text-neutral-400">Page {currentPage + 1} of {pageCount}</span>
              <button
                type="button"
                onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
                disabled={currentPage >= pageCount - 1}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700"
              >
                Next
              </button>
            </div>
          </nav>
        )}
      </section>
    </>
  )
}
