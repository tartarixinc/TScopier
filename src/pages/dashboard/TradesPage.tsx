import { useEffect, useState } from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import type { Trade } from '../../types/database'

type Filter = 'all' | 'open' | 'closed'
type LiveTrade = Omit<Trade, 'user_id' | 'signal_id' | 'metaapi_order_id' | 'created_at' | 'broker_account_id' | 'closed_at'> & {
  opened_at: string
}

export function TradesPage() {
  const { user } = useAuth()
  const [trades, setTrades] = useState<LiveTrade[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const AUTO_REFRESH_MS = 15000

  useEffect(() => {
    if (!user) return
    loadTrades()
  }, [user, filter])

  useEffect(() => {
    if (!user) return
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadTrades({ silent: true })
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(interval)
  }, [user, filter])

  const loadTrades = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true)
    try {
      if (!user?.id) {
        setTrades([])
        return
      }
      let q = supabase
        .from('trades')
        .select('symbol, direction, entry_price, lot_size, sl, tp, tp_levels, tp_open, status, profit, opened_at')
        .eq('user_id', user.id)
        .order('opened_at', { ascending: false })
      if (filter === 'open') q = q.eq('status', 'open')
      if (filter === 'closed') q = q.eq('status', 'closed')
      const { data, error } = await q
      if (error || !data) {
        setTrades([])
      } else {
        setTrades(data as LiveTrade[])
      }
    } catch {
      setTrades([])
    } finally {
      if (!silent) setLoading(false)
    }
  }

  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'Open' },
    { value: 'closed', label: 'Closed' },
  ]

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Trades</h1>
          <p className="text-sm text-neutral-500 mt-0.5">History of all copied trades</p>
        </div>
        <div className="flex bg-white border border-neutral-200 rounded-lg p-0.5 gap-0.5">
          {filters.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                filter === f.value
                  ? 'bg-teal-600 text-white'
                  : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <Card padding="none">
        {loading ? (
          <div className="divide-y divide-neutral-100">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="px-6 py-4 flex gap-4">
                {[...Array(9)].map((__, j) => (
                  <div key={j} className="h-4 bg-neutral-100 rounded animate-pulse flex-1" />
                ))}
              </div>
            ))}
          </div>
        ) : trades.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <TrendingUp className="w-10 h-10 mx-auto mb-3 text-neutral-200" />
            <p className="text-sm text-neutral-400 font-medium">No trades yet</p>
            <p className="text-xs text-neutral-300 mt-1">Trades stored in TSCopier appear here (live broker sync was removed).</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-[14%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[9%]" />
                <col className="w-[11%]" />
                <col className="w-[16%]" />
                <col className="w-[8%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-neutral-100 text-xs font-medium text-neutral-500 uppercase tracking-wide">
                  <th className="px-6 py-3 text-center">Symbol</th>
                  <th className="px-2 py-3 text-center">Direction</th>
                  <th className="px-2 py-3 text-center">Entry</th>
                  <th className="px-2 py-3 text-center">SL</th>
                  <th className="px-2 py-3 text-center">TP</th>
                  <th className="px-2 py-3 text-center">Lot Size</th>
                  <th className="px-2 py-3 text-center">PnL</th>
                  <th className="px-2 py-3 text-center">Date/Time</th>
                  <th className="px-6 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {trades.map(trade => <TradeRow key={trade.id} trade={trade} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function TradeRow({ trade }: { trade: LiveTrade }) {
  const dir = String(trade.direction ?? '').toLowerCase()
  const isBuy = dir === 'buy'
  const isSell = dir === 'sell'
  const profit = trade.profit

  const statusConfig: Record<string, { variant: 'success' | 'warning' | 'error' | 'neutral' | 'primary'; label: string }> = {
    open: { variant: 'primary', label: 'Open' },
    closed: { variant: 'neutral', label: 'Closed' },
    modified: { variant: 'warning', label: 'Modified' },
    cancelled: { variant: 'error', label: 'Cancelled' },
  }

  const status = statusConfig[trade.status] ?? { variant: 'neutral', label: trade.status }

  return (
    <tr className="hover:bg-neutral-50 transition-colors">
      <td className="px-6 py-3.5 text-sm font-semibold text-neutral-900 text-center">{trade.symbol}</td>
      <td className={`px-2 py-3.5 text-sm font-medium text-center ${
        isBuy ? 'text-success-600' : isSell ? 'text-error-600' : 'text-neutral-500'
      }`}>
        <span className="inline-flex items-center justify-center gap-1 w-full">
          {isBuy ? <TrendingUp className="w-3.5 h-3.5" /> : isSell ? <TrendingDown className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
          {isBuy ? 'Buy' : isSell ? 'Sell' : (trade.direction ? String(trade.direction) : '—')}
        </span>
      </td>
      <td className="px-2 py-3.5 text-sm text-neutral-700  text-center tabular-nums">{trade.entry_price?.toFixed(5) ?? '—'}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 text-center tabular-nums">{trade.sl?.toFixed(5) ?? '—'}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 text-center tabular-nums">{trade.tp?.toFixed(5) ?? '—'}</td>
      <td className="px-2 py-3.5 text-sm text-neutral-700 text-center tabular-nums">{trade.lot_size ?? '—'}</td>
      <td className={`px-2 py-3.5 text-sm font-medium text-center tabular-nums ${
        profit === null ? 'text-neutral-400' :
        profit > 0 ? 'text-success-600' :
        profit < 0 ? 'text-error-600' : 'text-neutral-500'
      }`}>
        {profit === null ? '—' : (
          <span className="inline-flex items-center justify-center gap-1 w-full">
            {profit > 0 ? <TrendingUp className="w-3 h-3" /> : profit < 0 ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
            {profit > 0 ? '+' : ''}{profit.toFixed(2)}
          </span>
        )}
      </td>
      <td className="px-2 py-3.5 text-xs text-neutral-500 whitespace-nowrap text-center">
        {trade.opened_at
          ? new Date(trade.opened_at).toLocaleString([], {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '—'}
      </td>
      <td className="px-6 py-3.5 text-center">
        <span className="inline-flex justify-center w-full">
          <Badge variant={status.variant} size="sm">{status.label}</Badge>
        </span>
      </td>
    </tr>
  )
}
