import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, ArrowDownRight, ChevronLeft, ChevronRight, Minus, RefreshCw, TrendingUp, TrendingDown } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Alert } from '../../components/ui/Alert'
import { metatraderApi, type MtTrade } from '../../lib/metatraderapi'

type Filter = 'all' | 'open' | 'closed'

const AUTO_REFRESH_MS = 15000
const PAGE_SIZE_OPTIONS = [10, 50, 100] as const
type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number]

export function TradesPage() {
  const t = useT()
  const { user } = useAuth()
  const [trades, setTrades] = useState<MtTrade[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSizeOption>(10)
  const inflightRef = useRef(false)

  const loadTrades = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (inflightRef.current) return
      inflightRef.current = true
      if (!silent) setLoading(true)
      else setRefreshing(true)
      try {
        if (!user?.id) {
          setTrades([])
          return
        }
        const res = await metatraderApi.trades({ scope: 'all' })
        setTrades(res.trades ?? [])
        setError(null)
        setLastSyncedAt(Date.now())
        if (res.debug?.raw_sample) {
          console.info('[Trades] raw sample order keys:', res.debug.raw_sample_keys)
          console.info('[Trades] raw sample order:', res.debug.raw_sample)
        }
      } catch (e) {
        if (!silent) {
          setTrades([])
        }
        setError(e instanceof Error ? e.message : 'Failed to load trades')
      } finally {
        inflightRef.current = false
        if (!silent) setLoading(false)
        else setRefreshing(false)
      }
    },
    [user?.id],
  )

  useEffect(() => {
    if (!user) return
    void loadTrades()
  }, [user, loadTrades])

  useEffect(() => {
    if (!user) return
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadTrades({ silent: true })
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(interval)
  }, [user, loadTrades])

  const filters: { value: Filter; label: string; count: number }[] = useMemo(
    () => [
      { value: 'all', label: t.trades.filterAll, count: trades.length },
      { value: 'open', label: t.trades.filterOpen, count: trades.filter(tr => tr.status === 'open').length },
      { value: 'closed', label: t.trades.filterClosed, count: trades.filter(tr => tr.status === 'closed').length },
    ],
    [t, trades],
  )

  const visibleTrades = useMemo(
    () => (filter === 'all' ? trades : trades.filter(t => t.status === filter)),
    [trades, filter],
  )

  const totalPages = Math.max(1, Math.ceil(visibleTrades.length / pageSize))

  useEffect(() => {
    setPage(1)
  }, [filter, pageSize])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const paginatedTrades = useMemo(() => {
    const start = (page - 1) * pageSize
    return visibleTrades.slice(start, start + pageSize)
  }, [visibleTrades, page, pageSize])

  const rangeStart = visibleTrades.length === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = Math.min(page * pageSize, visibleTrades.length)

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6 lg:p-8 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 sm:mb-6 gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-neutral-900 dark:text-neutral-50">{t.trades.title}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
            {t.trades.subtitle}
            {lastSyncedAt && (
              <span className="text-neutral-400">
                {' '}
                · {interpolate(t.common.synced, { time: formatRelative(lastSyncedAt) })}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => void loadTrades({ silent: true })}
            disabled={refreshing || loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md font-medium border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {t.trades.refresh}
          </button>
          <div className="flex flex-wrap bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-0.5 gap-0.5">
            {filters.map(f => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                  filter === f.value
                    ? 'bg-teal-600 text-white'
                    : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800'
                }`}
              >
                {f.label}
                <span className={`ml-1.5 text-xs ${filter === f.value ? 'text-teal-100' : 'text-neutral-400'}`}>{f.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && !loading && <Alert className="mb-4 px-4 py-2.5">{error}</Alert>}

      <Card padding="none">
        {loading ? (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="px-6 py-4 flex gap-4">
                {[...Array(9)].map((__, j) => (
                  <div key={j} className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse flex-1" />
                ))}
              </div>
            ))}
          </div>
        ) : visibleTrades.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <ArrowUpRight className="w-10 h-10 mx-auto mb-3 text-neutral-200" />
            <p className="text-sm text-neutral-400 font-medium">No trades to show</p>
            <p className="text-xs text-neutral-300 mt-1">
              {filter === 'open'
                ? 'No open positions on any of your linked broker accounts.'
                : filter === 'closed'
                  ? 'No recent closed orders in this MT session.'
                  : 'Connect a broker account in Account & Configuration to see live trades here.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-[13%]" />
                <col className="w-[10%]" />
                <col className="w-[12%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[8%]" />
                <col className="w-[10%]" />
                <col className="w-[14%]" />
                <col className="w-[6%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-neutral-100 dark:border-neutral-800 text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
                  <th className="px-4 py-3 text-center">Symbol</th>
                  <th className="px-2 py-3 text-center">Direction</th>
                  <th className="px-2 py-3 text-center">Broker</th>
                  <th className="px-2 py-3 text-center">Entry</th>
                  <th className="px-2 py-3 text-center">SL</th>
                  <th className="px-2 py-3 text-center">TP</th>
                  <th className="px-2 py-3 text-center">Lots</th>
                  <th className="px-2 py-3 text-center">PnL</th>
                  <th className="px-2 py-3 text-center">Time</th>
                  <th className="px-4 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {paginatedTrades.map(trade => <TradeRow key={trade.id} trade={trade} />)}
              </tbody>
            </table>
            {visibleTrades.length > 0 && (
              <TradesPagination
                page={page}
                pageSize={pageSize}
                totalPages={totalPages}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                total={visibleTrades.length}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            )}
          </div>
        )}
      </Card>
    </div>
  )
}

function TradesPagination({
  page,
  pageSize,
  totalPages,
  rangeStart,
  rangeEnd,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageSize: PageSizeOption
  totalPages: number
  rangeStart: number
  rangeEnd: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: PageSizeOption) => void
}) {
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

  return (
    <div className="flex flex-col gap-3 px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="inline-flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">Show</span>
          <select
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value) as PageSizeOption)}
            className="h-8 min-w-[4.5rem] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-2 text-sm text-neutral-900 dark:text-neutral-50 tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
            aria-label="Results per page"
          >
            {PAGE_SIZE_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span>results</span>
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
          Showing <span className="font-medium text-neutral-700 dark:text-neutral-300">{rangeStart}–{rangeEnd}</span> of{' '}
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{total}</span>
        </p>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-1 justify-end">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-white dark:bg-neutral-900 disabled:opacity-40 disabled:pointer-events-none"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Previous</span>
          </button>
          <div className="flex items-center gap-0.5">
            {pageNumbers[0]! > 1 && (
              <>
                <PageButton n={1} active={page === 1} onClick={() => onPageChange(1)} />
                {pageNumbers[0]! > 2 && <span className="px-1 text-neutral-400 text-sm">…</span>}
              </>
            )}
            {pageNumbers.map(n => (
              <PageButton key={n} n={n} active={page === n} onClick={() => onPageChange(n)} />
            ))}
            {pageNumbers[pageNumbers.length - 1]! < totalPages && (
              <>
                {pageNumbers[pageNumbers.length - 1]! < totalPages - 1 && (
                  <span className="px-1 text-neutral-400 text-sm">…</span>
                )}
                <PageButton n={totalPages} active={page === totalPages} onClick={() => onPageChange(totalPages)} />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-white dark:bg-neutral-900 disabled:opacity-40 disabled:pointer-events-none"
            aria-label="Next page"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}


function PageButton({ n, active, onClick }: { n: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`min-w-[2rem] px-2 py-1.5 text-sm rounded-md font-medium tabular-nums transition-colors ${
        active
          ? 'bg-teal-600 text-white'
          : 'text-neutral-600 dark:text-neutral-400 hover:bg-white dark:bg-neutral-900 border border-transparent hover:border-neutral-200 dark:border-neutral-800'
      }`}
    >
      {n}
    </button>
  )
}

function TradeRow({ trade }: { trade: MtTrade }) {
  const isBuy = trade.direction === 'buy'
  const isSell = trade.direction === 'sell'
  const profit = trade.profit

  const statusConfig: Record<string, { variant: 'success' | 'warning' | 'error' | 'neutral' | 'primary'; label: string }> = {
    open: { variant: 'primary', label: 'Open' },
    closed: { variant: 'neutral', label: 'Closed' },
  }
  const status = statusConfig[trade.status] ?? { variant: 'neutral', label: trade.status }

  const timeIso = trade.status === 'closed' ? (trade.closed_at ?? trade.opened_at) : trade.opened_at
  const broker = trade.broker_name || trade.broker_label || '—'

  // Prefer the normalized type label (handles "Buy", "Sell", "Buy Limit", etc.).
  // Fall back to the bare direction so we never render an empty cell for tradeable rows.
  const directionLabel = trade.type
    ? trade.type
    : isBuy
      ? 'Buy'
      : isSell
        ? 'Sell'
        : '—'

  return (
    <tr className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
      <td className="px-4 py-3.5 text-sm font-semibold text-neutral-900 dark:text-neutral-50 text-center">
        <div>{trade.symbol || '—'}</div>
        <div className="text-[10px] text-neutral-400 font-normal tabular-nums mt-0.5">#{trade.ticket}</div>
      </td>
      <td className={`px-2 py-3.5 text-sm font-medium text-center ${
        isBuy ? 'text-success-600' : isSell ? 'text-error-600' : 'text-neutral-500 dark:text-neutral-400'
      }`}>
        <span className="inline-flex items-center justify-center gap-1 w-full">
          {isBuy ? <ArrowUpRight className="w-3.5 h-3.5" /> : isSell ? <ArrowDownRight className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
          {directionLabel}
        </span>
      </td>
      <td className="px-2 py-3.5 text-xs text-neutral-600 dark:text-neutral-400 text-center truncate" title={broker}>{broker}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 dark:text-neutral-300 text-center tabular-nums">{formatPrice(trade.entry_price)}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 dark:text-neutral-300 text-center tabular-nums">{formatPrice(trade.sl)}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 dark:text-neutral-300 text-center tabular-nums">{formatPrice(trade.tp)}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 dark:text-neutral-300 text-center tabular-nums">{trade.lot_size ? trade.lot_size.toFixed(2) : '—'}</td>
      <td className={`px-2 py-3.5 text-sm font-medium text-center tabular-nums ${
        profit === null ? 'text-neutral-400' :
        profit > 0 ? 'text-success-600' :
        profit < 0 ? 'text-error-600' : 'text-neutral-500 dark:text-neutral-400'
      }`}>
        {profit === null ? '—' : (
          <span className="inline-flex items-center justify-center gap-1 w-full">
            {profit > 0 ? <TrendingUp className="w-3 h-3" /> : profit < 0 ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
            {profit > 0 ? '+' : ''}{profit.toFixed(2)}
          </span>
        )}
      </td>
      <td className="px-2 py-3.5 text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap text-center">
        {timeIso
          ? new Date(timeIso).toLocaleString([], {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '—'}
      </td>
      <td className="px-4 py-3.5 text-center">
        <span className="inline-flex justify-center w-full">
          <Badge variant={status.variant} size="sm">{status.label}</Badge>
        </span>
      </td>
    </tr>
  )
}

function formatPrice(value: number | null): string {
  if (value === null || value === undefined) return '—'
  if (!Number.isFinite(value) || value === 0) return '—'
  return value.toFixed(5)
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const sec = Math.floor(diff / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  return `${hr}h ago`
}
