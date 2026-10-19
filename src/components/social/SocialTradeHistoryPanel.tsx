import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, LineChart, Wallet } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { summarizeSocialTradesByDay } from '../../lib/socialPerformancePresentation'
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

type ProfileTab = 'performance' | 'trading' | 'portfolio'

function when(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

function money(value: number | null, currency: string | null): string {
  if (value == null) return 'Unavailable'
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`
}

function performanceNotice(performance: SocialProviderPerformance): { variant: 'warning' | 'error'; text: string } | null {
  if (performance.performanceStatus === 'available') return null
  if (performance.performanceStatus === 'no_history') return { variant: 'warning', text: 'No TSCopier-recorded trading history exists for this selected source yet.' }
  if (performance.performanceStatus === 'pending') return { variant: 'warning', text: 'History synchronization is pending. Performance remains unavailable until synchronization succeeds.' }
  if (performance.performanceStatus === 'stale') return { variant: 'warning', text: 'History is stale. The figures shown are historical and copying is blocked until the source synchronizes.' }
  if (performance.performanceStatus === 'incomplete') return { variant: 'warning', text: 'History is incomplete because at least one closed trade lacks a broker ticket or realized result.' }
  if (performance.performanceStatus === 'failed') return { variant: 'error', text: 'History synchronization failed. The source account must be reconnected.' }
  return { variant: 'error', text: 'History is unavailable because the selected source is inactive, disconnected, missing, or unsupported.' }
}

function eligibilityText(reason: string): string {
  if (reason === 'eligible') return 'Eligible for demo copying'
  if (reason === 'minimum_trades_not_met') return 'Copy unavailable: requires 10 complete closed trades'
  if (reason === 'minimum_period_not_met') return 'Copy unavailable: history must span 7 days'
  if (reason === 'demo_only') return 'Copy unavailable: this phase permits demo accounts only'
  if (reason === 'history_stale') return 'Copy unavailable: synchronization is stale'
  if (reason === 'history_incomplete') return 'Copy unavailable: history is incomplete'
  if (reason === 'sync_pending') return 'Copy unavailable: synchronization is pending'
  if (reason === 'sync_failed') return 'Copy unavailable: synchronization failed'
  return 'Copy is not currently eligible'
}

function EnvironmentBadge({ mode }: { mode: SocialProviderPerformance['accountMode'] }) {
  const label = mode === 'demo' ? 'DEMO' : mode === 'live' ? 'LIVE' : 'UNKNOWN'
  return <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide', mode === 'demo' ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300' : mode === 'live' ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300')}>{label}</span>
}

function ProfileTabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: string }) {
  return <button type="button" onClick={onClick} className={clsx('inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium', active ? 'bg-green-400 text-neutral-950' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800')}>{icon}{children}</button>
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return <div><dt className="text-xs text-neutral-500 dark:text-neutral-400">{label}</dt><dd className={clsx('mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-50', tone === 'up' && 'text-green-600 dark:text-green-400', tone === 'down' && 'text-red-600 dark:text-red-400')}>{value}</dd></div>
}

function TradeRows({ rows }: { rows: SocialTradeHistoryItem[] }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead><tr className="border-b border-neutral-100 text-left text-xs text-neutral-500 dark:border-neutral-800"><th className="px-4 py-3">Instrument</th><th className="px-3 py-3">Direction</th><th className="px-3 py-3">Opened</th><th className="px-3 py-3">Closed</th><th className="px-4 py-3 text-end">Realized P/L</th></tr></thead><tbody>{rows.map(trade => <tr key={trade.tradeId} className="border-t border-neutral-100 dark:border-neutral-800"><td className="px-4 py-3 font-medium">{trade.symbol || 'Unknown'}</td><td className={clsx('px-3 py-3 font-medium', trade.direction === 'buy' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>{trade.direction.toUpperCase()}</td><td className="px-3 py-3">{when(trade.openedAt)}</td><td className="px-3 py-3">{when(trade.closedAt)}</td><td className={clsx('px-4 py-3 text-end font-medium', trade.realizedProfit == null ? 'text-neutral-500' : trade.realizedProfit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>{trade.realizedProfit == null ? '—' : trade.realizedProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>)}</tbody></table></div>
}

function DailyPerformance({ trades, currency }: { trades: SocialTradeHistoryItem[]; currency: string | null }) {
  const days = summarizeSocialTradesByDay(trades)
  const visible = days.slice(-14)
  const max = Math.max(1, ...visible.map(day => Math.abs(day.profit)))
  return <Card><h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Recent realized performance</h2><p className="mt-1 text-xs text-neutral-500">Daily totals from the source trades shown below; this is not an equity curve.</p>{visible.length === 0 ? <p className="py-8 text-sm text-neutral-500">No qualifying closed history.</p> : <div className="mt-5 flex h-48 items-end gap-2 overflow-x-auto">{visible.map(day => <div key={day.key} className="flex min-w-10 flex-1 flex-col items-center justify-end gap-2"><span className="text-[10px] text-neutral-500">{day.profit.toLocaleString()}</span><div title={`${day.key}: ${money(day.profit, currency)}`} className={clsx('w-full max-w-10 rounded-t', day.profit >= 0 ? 'bg-green-400' : 'bg-red-400')} style={{ height: `${Math.max(4, Math.abs(day.profit) / max * 120)}px` }} /><span className="text-[10px] text-neutral-500">{day.key.slice(5)}</span></div>)}</div>}</Card>
}

export function SocialTradeHistoryPanel({ traderUserId, isSelf }: { traderUserId: string; isSelf: boolean }) {
  const [access, setAccess] = useState<SocialTradeHistoryAccess | null>(null)
  const [performance, setPerformance] = useState<SocialProviderPerformance | null>(null)
  const [trades, setTrades] = useState<SocialTradeHistoryItem[]>([])
  const [tab, setTab] = useState<ProfileTab>('performance')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const nextAccess = await fetchSocialTradeHistoryAccess(supabase, traderUserId)
      const rows = nextAccess.canView ? await fetchSocialProviderPerformance(supabase, traderUserId) : []
      const selected = rows.find(item => item.sourceStatus === 'published') ?? null
      const nextTrades = nextAccess.canView && selected ? await fetchSocialTradeHistory(supabase, selected.sourceId) : []
      setAccess(nextAccess); setPerformance(selected); setTrades(nextTrades); setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load trade history.')
    } finally { setLoading(false) }
  }, [traderUserId])
  useEffect(() => { void Promise.resolve().then(refresh) }, [refresh])

  const open = useMemo(() => trades.filter(trade => trade.status === 'open'), [trades])
  const closed = useMemo(() => trades.filter(trade => trade.status === 'closed'), [trades])
  const notice = performance ? performanceNotice(performance) : null
  const changeSharing = async () => {
    if (saving || !access) return
    setSaving(true); setError(null)
    try { await setSocialTradeHistorySharing(supabase, !access.sharingEnabled); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update trade-history sharing.') }
    finally { setSaving(false) }
  }

  if (loading) return <Card><p className="py-6 text-sm text-neutral-500">Loading performance and trade history…</p></Card>
  if (error) return <Card><Alert variant="error">{error}</Alert><Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => void refresh()}>Retry</Button></Card>
  if (access && !access.canView) return <Card><h2 className="text-sm font-semibold">Private trading history</h2><p className="mt-2 text-sm text-neutral-500">This trader has not shared trading history with you.</p></Card>
  if (!performance) return <Card><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Performance unavailable</h2><p className="mt-2 text-sm text-neutral-500">No selected published source account is available.</p></div>{isSelf && access ? <Button type="button" size="sm" variant="secondary" loading={saving} disabled={saving} onClick={() => void changeSharing()}>{access.sharingEnabled ? 'Stop sharing' : 'Share trade history'}</Button> : null}</div></Card>

  return <div className="space-y-4">
    <Card><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{performance.sourceLabel}</h2><EnvironmentBadge mode={performance.accountMode} /></div><p className="mt-1 text-xs text-neutral-500">Selected source account · Last synchronized {when(performance.lastSyncSucceededAt)}</p><p className="mt-2 text-xs text-neutral-500">{eligibilityText(performance.eligibilityReason)}</p></div>{isSelf && access ? <Button type="button" size="sm" variant="secondary" loading={saving} disabled={saving} onClick={() => void changeSharing()}>{access.sharingEnabled ? 'Stop sharing' : 'Share trade history'}</Button> : null}</div>{notice ? <div className="mt-4"><Alert variant={notice.variant}>{notice.text}</Alert></div> : null}</Card>
    <div className="flex gap-2 overflow-x-auto"><ProfileTabButton icon={<BarChart3 className="h-4 w-4" />} active={tab === 'performance'} onClick={() => setTab('performance')}>Performance</ProfileTabButton><ProfileTabButton icon={<LineChart className="h-4 w-4" />} active={tab === 'trading'} onClick={() => setTab('trading')}>Trading</ProfileTabButton><ProfileTabButton icon={<Wallet className="h-4 w-4" />} active={tab === 'portfolio'} onClick={() => setTab('portfolio')}>Portfolio</ProfileTabButton></div>
    {tab === 'performance' ? <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]"><div className="min-w-0 space-y-4"><DailyPerformance trades={closed} currency={performance.currency} /><Card><h2 className="text-sm font-semibold">Statistics</h2><dl className="mt-4 grid grid-cols-2 gap-5 sm:grid-cols-3"><Metric label="Realized P/L" value={money(performance.realizedProfit, performance.currency)} tone={performance.realizedProfit == null ? undefined : performance.realizedProfit >= 0 ? 'up' : 'down'} /><Metric label="Closed trades" value={String(performance.closedTradeCount)} /><Metric label="Open trades" value={String(performance.openTradeCount)} /><Metric label="Win rate" value={performance.winRate == null ? 'Unavailable' : `${performance.winRate.toFixed(2)}%`} /><Metric label="Profit factor" value={performance.profitFactor == null ? 'Unavailable' : performance.profitFactor.toFixed(2)} /><Metric label="History period" value={performance.periodStartedAt && performance.periodEndedAt ? `${new Date(performance.periodStartedAt).toLocaleDateString()} – ${new Date(performance.periodEndedAt).toLocaleDateString()}` : 'Unavailable'} /></dl></Card></div><Card className="xl:sticky xl:top-4"><h2 className="text-sm font-semibold">Overview</h2><dl className="mt-4 space-y-3"><Metric label="Account environment" value={performance.accountMode.toUpperCase()} /><Metric label="Return" value="Unavailable" /><Metric label="Maximum drawdown" value="Unavailable" /><Metric label="Equity curve" value="Unavailable" /><Metric label="Calculated" value={when(performance.calculatedAt)} /></dl><p className="mt-4 text-xs leading-5 text-neutral-500">Returns, drawdown and an equity curve remain unavailable because cash-flow and periodic equity history do not yet support defensible calculations.</p></Card></div> : null}
    {tab === 'trading' ? <div className="space-y-4">{open.length > 0 ? <Card padding="none" className="overflow-hidden"><h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold dark:border-neutral-800">Open positions ({open.length})</h2><TradeRows rows={open} /></Card> : <Card><p className="text-sm text-neutral-500">No open positions are recorded for this source.</p></Card>}{closed.length > 0 ? <Card padding="none" className="overflow-hidden"><h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold dark:border-neutral-800">Closed trades ({closed.length})</h2><TradeRows rows={closed} /></Card> : <Card><p className="text-sm text-neutral-500">No qualifying closed history is recorded for this source.</p></Card>}</div> : null}
    {tab === 'portfolio' ? <Card><h2 className="text-sm font-semibold">Portfolio history unavailable</h2><p className="mt-2 text-sm leading-6 text-neutral-500">The approved preview's balance and equity charts require periodic broker equity snapshots. They are intentionally unavailable until the backend can substantiate them.</p></Card> : null}
    <p className="text-xs leading-5 text-neutral-500">Metrics and rows include only TSCopier-recorded trades attributed to this selected source account. Destination-side copy executions are excluded. Broker account identifiers and credentials are never shown.</p>
  </div>
}
