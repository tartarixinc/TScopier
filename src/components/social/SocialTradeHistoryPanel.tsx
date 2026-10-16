import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import {
  fetchSocialTradeHistory,
  fetchSocialTradeHistoryAccess,
  setSocialTradeHistorySharing,
  type SocialTradeHistoryAccess,
  type SocialTradeHistoryItem,
} from '../../lib/socialTradeHistory'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

function when(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

function TradeRows({ rows }: { rows: SocialTradeHistoryItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-sm">
        <thead><tr className="border-b border-neutral-100 text-left text-xs text-neutral-500 dark:border-neutral-800"><th className="px-4 py-3">Instrument</th><th className="px-3 py-3">Direction</th><th className="px-3 py-3">Opened</th><th className="px-3 py-3">Closed</th><th className="px-4 py-3 text-end">Realised P&amp;L</th></tr></thead>
        <tbody>{rows.map(trade => <tr key={trade.tradeId} className="border-t border-neutral-100 dark:border-neutral-800">
          <td className="px-4 py-3 font-medium">{trade.symbol || 'Unknown'}</td>
          <td className={clsx('px-3 py-3 font-medium', trade.direction === 'buy' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>{trade.direction.toUpperCase()}</td>
          <td className="px-3 py-3">{when(trade.openedAt)}</td><td className="px-3 py-3">{when(trade.closedAt)}</td>
          <td className={clsx('px-4 py-3 text-end font-medium', trade.realizedProfit == null ? 'text-neutral-500' : trade.realizedProfit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>{trade.realizedProfit == null ? '—' : trade.realizedProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        </tr>)}</tbody>
      </table>
    </div>
  )
}

export function SocialTradeHistoryPanel({ traderUserId, isSelf }: { traderUserId: string; isSelf: boolean }) {
  const [access, setAccess] = useState<SocialTradeHistoryAccess | null>(null)
  const [trades, setTrades] = useState<SocialTradeHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const nextAccess = await fetchSocialTradeHistoryAccess(supabase, traderUserId)
      const nextTrades = nextAccess.canView ? await fetchSocialTradeHistory(supabase, traderUserId) : []
      setAccess(nextAccess)
      setTrades(nextTrades)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load trade history.')
    } finally {
      setLoading(false)
    }
  }, [traderUserId])

  useEffect(() => { void Promise.resolve().then(refresh) }, [refresh])

  const open = useMemo(() => trades.filter(trade => trade.status === 'open'), [trades])
  const closed = useMemo(() => trades.filter(trade => trade.status === 'closed'), [trades])

  const changeSharing = async () => {
    if (saving || !access) return
    setSaving(true)
    setError(null)
    try {
      await setSocialTradeHistorySharing(supabase, !access.sharingEnabled)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update trade-history sharing.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <div><h2 className="text-sm font-semibold">Trade history</h2><p className="mt-1 text-xs text-neutral-500">Genuine TScopier-recorded trades only. Broker account identifiers and credentials are never shown.</p></div>
        {isSelf && access ? <Button type="button" size="sm" variant="secondary" loading={saving} disabled={saving} onClick={() => void changeSharing()}>{access.sharingEnabled ? 'Stop sharing' : 'Share trade history'}</Button> : null}
      </div>
      {loading ? <p className="px-4 py-8 text-sm text-neutral-500">Loading trade history…</p> : null}
      {error ? <div className="m-4"><Alert variant="error">{error}</Alert><Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => void refresh()}>Retry</Button></div> : null}
      {!loading && !error && access && !access.canView ? <p className="px-4 py-8 text-sm text-neutral-500">This trader has not shared trade history with you.</p> : null}
      {!loading && !error && access?.canView && trades.length === 0 ? <p className="px-4 py-8 text-sm text-neutral-500">No TScopier-recorded open or closed trades are available.</p> : null}
      {!loading && !error && access?.canView && open.length > 0 ? <section><h3 className="bg-neutral-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide dark:bg-neutral-900">Open positions ({open.length})</h3><TradeRows rows={open} /></section> : null}
      {!loading && !error && access?.canView && closed.length > 0 ? <section><h3 className="bg-neutral-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide dark:bg-neutral-900">Closed trades ({closed.length})</h3><TradeRows rows={closed} /></section> : null}
    </Card>
  )
}
