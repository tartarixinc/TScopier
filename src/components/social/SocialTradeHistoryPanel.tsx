import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import {
  fetchSocialProviderPerformance,
  fetchSocialTradeHistory,
  fetchSocialTradeHistoryAccess,
  setSocialTradeHistorySharing,
  type SocialProviderPerformance,
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

function performanceNotice(performance: SocialProviderPerformance): { variant: 'warning' | 'error'; text: string } | null {
  if (performance.performanceStatus === 'available') return null
  if (performance.performanceStatus === 'no_history') return { variant: 'warning', text: 'No TSCopier-recorded trading history exists for this published source yet.' }
  if (performance.performanceStatus === 'pending') return { variant: 'warning', text: 'History synchronization is pending. Performance will remain unavailable until the source has synchronized successfully.' }
  if (performance.performanceStatus === 'stale') return { variant: 'warning', text: 'History is stale because the source has not synchronized in the last 15 minutes. Metrics below are historical and copying is blocked.' }
  if (performance.performanceStatus === 'incomplete') return { variant: 'warning', text: 'History is incomplete because one or more closed trades lacks a broker ticket or realized result.' }
  if (performance.performanceStatus === 'failed') return { variant: 'error', text: 'History synchronization failed. The provider must reconnect the source account.' }
  return { variant: 'error', text: 'History is unavailable because the published source is inactive, disconnected, missing, or unsupported.' }
}

function eligibilityText(reason: string): string {
  if (reason === 'eligible') return 'Eligible for demo copying'
  if (reason === 'minimum_trades_not_met') return 'Not copy eligible: requires 10 complete closed trades'
  if (reason === 'minimum_period_not_met') return 'Not copy eligible: history must span 7 days'
  if (reason === 'demo_only') return 'Not copy eligible: Phase 1 is demo-only'
  if (reason === 'history_stale') return 'Not copy eligible: synchronization is stale'
  if (reason === 'history_incomplete') return 'Not copy eligible: history is incomplete'
  if (reason === 'sync_pending') return 'Not copy eligible: synchronization is pending'
  if (reason === 'sync_failed') return 'Not copy eligible: synchronization failed'
  return 'Not currently eligible for copying'
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
  const [performances, setPerformances] = useState<SocialProviderPerformance[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [trades, setTrades] = useState<SocialTradeHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const nextAccess = await fetchSocialTradeHistoryAccess(supabase, traderUserId)
      const nextPerformances = nextAccess.canView ? await fetchSocialProviderPerformance(supabase, traderUserId) : []
      const nextSourceId = nextPerformances.some(item => item.sourceId === selectedSourceId)
        ? selectedSourceId
        : (nextPerformances[0]?.sourceId ?? '')
      const nextTrades = nextAccess.canView && nextSourceId
        ? await fetchSocialTradeHistory(supabase, nextSourceId)
        : []
      setAccess(nextAccess)
      setPerformances(nextPerformances)
      setSelectedSourceId(nextSourceId)
      setTrades(nextTrades)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load trade history.')
    } finally {
      setLoading(false)
    }
  }, [selectedSourceId, traderUserId])

  useEffect(() => { void Promise.resolve().then(refresh) }, [refresh])

  const open = useMemo(() => trades.filter(trade => trade.status === 'open'), [trades])
  const closed = useMemo(() => trades.filter(trade => trade.status === 'closed'), [trades])
  const selectedPerformance = performances.find(item => item.sourceId === selectedSourceId) ?? performances[0] ?? null
  const notice = selectedPerformance ? performanceNotice(selectedPerformance) : null

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
      {!loading && !error && access?.canView && performances.length === 0 ? <p className="px-4 py-8 text-sm text-neutral-500">No published source account is available for performance history.</p> : null}
      {!loading && !error && selectedPerformance ? <div className="space-y-3 border-b border-neutral-100 p-4 dark:border-neutral-800">
        {performances.length > 1 ? <label className="block text-xs text-neutral-500">Published source
          <select className="mt-1 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900 sm:max-w-sm" value={selectedSourceId} onChange={event => setSelectedSourceId(event.target.value)}>
            {performances.map(item => <option key={item.sourceId} value={item.sourceId}>{item.sourceLabel} · {item.accountMode}</option>)}
          </select>
        </label> : <p className="text-sm font-medium">{selectedPerformance.sourceLabel} · {selectedPerformance.accountMode}</p>}
        {notice ? <Alert variant={notice.variant}>{notice.text}</Alert> : <Alert variant="success">Performance is available and the source synchronization is current.</Alert>}
        <p className="text-xs text-neutral-500">{eligibilityText(selectedPerformance.eligibilityReason)}</p>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-neutral-500">Closed trades</dt><dd className="font-semibold">{selectedPerformance.closedTradeCount}</dd></div>
          <div><dt className="text-xs text-neutral-500">Realized P&amp;L</dt><dd className="font-semibold">{selectedPerformance.realizedProfit == null ? 'Unavailable' : `${selectedPerformance.realizedProfit.toLocaleString()}${selectedPerformance.currency ? ` ${selectedPerformance.currency}` : ''}`}</dd></div>
          <div><dt className="text-xs text-neutral-500">Win rate</dt><dd className="font-semibold">{selectedPerformance.winRate == null ? 'Unavailable' : `${selectedPerformance.winRate.toFixed(2)}%`}</dd></div>
          <div><dt className="text-xs text-neutral-500">Profit factor</dt><dd className="font-semibold">{selectedPerformance.profitFactor == null ? 'Unavailable' : selectedPerformance.profitFactor.toFixed(2)}</dd></div>
        </dl>
        <p className="text-xs text-neutral-500">Return, maximum drawdown and equity curve are unavailable until cash-flow and periodic equity history can support defensible calculations. Realized P&amp;L uses the broker-reported result stored for complete closed trades; separately itemized fees and swaps are not available for every provider.</p>
        <p className="text-xs text-neutral-500">Last successful source sync: {when(selectedPerformance.lastSyncSucceededAt)} · Calculated: {when(selectedPerformance.calculatedAt)}</p>
      </div> : null}
      {!loading && !error && access?.canView && selectedPerformance && trades.length === 0 ? <p className="px-4 py-8 text-sm text-neutral-500">No TScopier-recorded open or closed trades are available for this source.</p> : null}
      {!loading && !error && access?.canView && open.length > 0 ? <section><h3 className="bg-neutral-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide dark:bg-neutral-900">Open positions ({open.length})</h3><TradeRows rows={open} /></section> : null}
      {!loading && !error && access?.canView && closed.length > 0 ? <section><h3 className="bg-neutral-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide dark:bg-neutral-900">Closed trades ({closed.length})</h3><TradeRows rows={closed} /></section> : null}
    </Card>
  )
}
