import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Check, CircleMinus, LineChart, Wallet } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { summarizeSocialTradesByDay } from '../../lib/socialPerformancePresentation'
import { eligibilityDiagnosticForReason } from '../../lib/socialEligibility'
import { SocialEligibilityDiagnostics } from './SocialEligibilityDiagnostics'
import { fetchSocialCopySources, type SocialCopySource } from '../../lib/socialCopy'
import {
  fetchSocialProviderPerformance,
  fetchSocialTradeHistory,
  fetchSocialTradeHistoryAccess,
  canLoadSocialTradeHistory,
  socialCopyEligibilityChecks,
  socialPerformanceStatusMessage,
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
  if (value == null) return '—'
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`
}

function performanceNotice(performance: SocialProviderPerformance): { variant: 'warning' | 'error'; text: string } | null {
  const text = socialPerformanceStatusMessage(performance.performanceStatus, performance.statusReason)
  if (!text) return null
  return { variant: performance.performanceStatus === 'failed' || performance.performanceStatus === 'unavailable' ? 'error' : 'warning', text }
}

function EnvironmentBadge({ mode, synthetic = false }: { mode: SocialProviderPerformance['accountMode']; synthetic?: boolean }) {
  const label = mode === 'demo' ? 'DEMO' : mode === 'live' ? 'LIVE' : 'UNKNOWN'
  return <span className="inline-flex flex-wrap items-center gap-1"><span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide', mode === 'demo' ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300' : mode === 'live' ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300')}>{label}</span>{synthetic ? <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">DEMO DATA</span> : null}</span>
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


function PnlCalendar({ trades, currency }: { trades: SocialTradeHistoryItem[]; currency: string | null }) {
  const days = summarizeSocialTradesByDay(trades)
  const latest = days.at(-1)?.key
  const anchor = latest ? new Date(`${latest}T00:00:00Z`) : new Date()
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth()
  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2026, 8, 6 + index)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }))
  const leading = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const byDay = new Map(days.filter(day => day.key.startsWith(`${year}-${String(month + 1).padStart(2, '0')}-`)).map(day => [Number(day.key.slice(8)), day]))

  return <Card><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">P/L calendar</h2><span className="text-xs text-neutral-500">{monthLabel}</span></div><p className="mt-1 text-xs text-neutral-500">Daily realized P/L from the same closed source trades shown in the table.</p><div className="mt-4 grid grid-cols-7 gap-2">{weekdays.map(label => <div key={label} className="pb-1 text-center text-[11px] font-medium text-neutral-900 dark:text-neutral-50">{label}</div>)}{Array.from({ length: leading }, (_, index) => <div key={`lead-${index}`} aria-hidden="true" />)}{Array.from({ length: count }, (_, index) => { const dayNumber = index + 1; const day = byDay.get(dayNumber); const tone = !day ? 'border-neutral-100 text-neutral-500 dark:border-neutral-800' : day.profit > 0 ? 'border-green-200 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-400/15 dark:text-green-200' : day.profit < 0 ? 'border-red-100 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200' : 'border-neutral-200 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'; return <div key={dayNumber} title={day ? `${day.key}: ${money(day.profit, currency)}` : undefined} className={clsx('min-h-[72px] rounded-lg border px-2 py-2 text-start text-xs', tone)}><span className="text-[11px]">{String(dayNumber).padStart(2, '0')}</span>{day ? <><p className="mt-1 font-semibold">{money(day.profit, currency)}</p><p className="text-[11px] opacity-80">{day.tradeCount} {day.tradeCount === 1 ? 'trade' : 'trades'}</p></> : <p className="mt-2 text-[11px]">No trades</p>}</div> })}</div></Card>
}

export function SocialTradeHistoryPanel({ traderUserId, isSelf }: { traderUserId: string; isSelf: boolean }) {
  const [access, setAccess] = useState<SocialTradeHistoryAccess | null>(null)
  const [performance, setPerformance] = useState<SocialProviderPerformance | null>(null)
  const [source, setSource] = useState<SocialCopySource | null>(null)
  const [trades, setTrades] = useState<SocialTradeHistoryItem[]>([])
  const [tab, setTab] = useState<ProfileTab>('performance')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const nextAccess = await fetchSocialTradeHistoryAccess(supabase, traderUserId)
      const canLoad = canLoadSocialTradeHistory(nextAccess, isSelf)
      const rows = canLoad ? await fetchSocialProviderPerformance(supabase, traderUserId) : []
      const selected = rows.find(item => item.sourceStatus === 'published') ?? null
      const sources = canLoad ? await fetchSocialCopySources(supabase, traderUserId) : []
      const nextTrades = canLoad && selected ? await fetchSocialTradeHistory(supabase, selected.sourceId) : []
      setAccess(nextAccess); setPerformance(selected); setSource(sources.find(item => item.sourceId === selected?.sourceId) ?? null); setTrades(nextTrades); setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load trade history.')
    } finally { setLoading(false) }
  }, [isSelf, traderUserId])
  useEffect(() => { void Promise.resolve().then(refresh) }, [refresh])

  const open = useMemo(() => trades.filter(trade => trade.status === 'open'), [trades])
  const closed = useMemo(() => trades.filter(trade => trade.status === 'closed'), [trades])
  const notice = performance ? performanceNotice(performance) : null
  const eligibilityDiagnostic = performance
    ? source?.eligibilityDiagnostics.find(diagnostic => diagnostic.code === performance.eligibilityReason)
      ?? eligibilityDiagnosticForReason(performance.eligibilityReason)
    : eligibilityDiagnosticForReason('source_not_published')
  const platform = source?.platform.trim().toUpperCase()
  const platformLabel = platform === 'MT4' || platform === 'MT5' ? platform : '—'
  const accountType = performance?.accountMode === 'demo'
    ? 'Demo account'
    : performance?.accountMode === 'live'
      ? 'Live account'
      : '—'
  const partialMetrics = performance != null && !performance.historyComplete && performance.closedTradeCount > 0
  const changeSharing = async () => {
    if (saving || !access) return
    setSaving(true); setError(null)
    try { await setSocialTradeHistorySharing(supabase, !access.sharingEnabled); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update trade-history sharing.') }
    finally { setSaving(false) }
  }

  if (loading) return <Card><p className="py-6 text-sm text-neutral-500">Loading performance and trade history…</p></Card>
  if (error) return <Card><Alert variant="error">{error}</Alert><Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => void refresh()}>Retry</Button></Card>
  if (access && !isSelf && !access.canView) return <Card><h2 className="text-sm font-semibold">Private trading history</h2><p className="mt-2 text-sm text-neutral-500">This trader has not shared trading history with you.</p></Card>
  if (!performance) return <Card><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Performance unavailable</h2><p className="mt-2 text-sm text-neutral-500">{eligibilityDiagnostic.explanation} {eligibilityDiagnostic.nextAction}</p></div>{isSelf && access ? <Button type="button" size="sm" variant="secondary" loading={saving} disabled={saving} onClick={() => void changeSharing()}>{access.sharingEnabled ? 'Stop sharing' : 'Share trade history'}</Button> : null}</div></Card>

  return <div className="space-y-4">
    <Card>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        {isSelf && access ? <div className="order-first flex sm:order-last sm:justify-end"><Button type="button" size="sm" variant="secondary" loading={saving} disabled={saving} onClick={() => void changeSharing()}>{access.sharingEnabled ? 'Stop sharing' : 'Share trade history'}</Button></div> : null}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div>
              <p className="text-[11px] text-neutral-500">Trading platform</p>
              <h2 className="text-base font-bold text-neutral-900 dark:text-neutral-50">{platformLabel} Account</h2>
            </div>
            <EnvironmentBadge mode={performance.accountMode} synthetic={performance.isSynthetic} />
          </div>
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <div className="flex items-center gap-1"><dt className="text-neutral-500">Account type</dt><dd className="font-semibold text-neutral-800 dark:text-neutral-200">{accountType}</dd></div>
            <div><dt className="sr-only">Source account synchronization</dt><dd className="text-neutral-500">Selected source · Last synchronized {when(performance.lastSyncSucceededAt)}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-neutral-500">
            {eligibilityDiagnostic.explanation}
            {eligibilityDiagnostic.nextAction ? ` ${eligibilityDiagnostic.nextAction}` : ''}
          </p>
          {source?.eligibilityDiagnostics.length ? (
            <div className="mt-2">
              <SocialEligibilityDiagnostics diagnostics={source.eligibilityDiagnostics} title="Copy eligibility" />
            </div>
          ) : performance ? (
            <ul aria-label="Copy eligibility" className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {socialCopyEligibilityChecks(performance.isCopyEligible, performance.eligibilityReason).map(check => (
                <li key={check.label} title={check.label} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-neutral-600 dark:text-neutral-300">
                  {check.status === 'passed'
                    ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    : <CircleMinus className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />}
                  <span className="truncate" aria-label={`${check.status === 'passed' ? 'Passed' : 'Not passed'}: ${check.label}`}>{check.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {notice ? <div className="mt-3"><Alert variant={notice.variant}>{notice.text}</Alert></div> : null}
    </Card>
    <div className="flex gap-2 overflow-x-auto"><ProfileTabButton icon={<BarChart3 className="h-4 w-4" />} active={tab === 'performance'} onClick={() => setTab('performance')}>Performance</ProfileTabButton><ProfileTabButton icon={<LineChart className="h-4 w-4" />} active={tab === 'trading'} onClick={() => setTab('trading')}>Trading</ProfileTabButton><ProfileTabButton icon={<Wallet className="h-4 w-4" />} active={tab === 'portfolio'} onClick={() => setTab('portfolio')}>Portfolio</ProfileTabButton></div>
    {tab === 'performance' ? (
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <DailyPerformance trades={closed} currency={performance.currency} />
          <PnlCalendar trades={closed} currency={performance.currency} />
          <Card>
            <h2 className="text-sm font-semibold">Statistics</h2>
            <dl className="mt-4 grid grid-cols-2 gap-5 sm:grid-cols-3">
              <Metric label={partialMetrics ? 'Realized P/L (partial)' : 'Realized P/L'} value={money(performance.realizedProfit, performance.currency)} tone={performance.realizedProfit == null ? undefined : performance.realizedProfit >= 0 ? 'up' : 'down'} />
              <Metric label="Closed trades" value={String(performance.closedTradeCount)} />
              <Metric label="Open trades" value={String(performance.openTradeCount)} />
              <Metric label={partialMetrics ? 'Win rate (partial)' : 'Win rate'} value={performance.winRate == null ? '—' : `${performance.winRate.toFixed(2)}%`} />
              <Metric label={partialMetrics ? 'Profit factor (partial)' : 'Profit factor'} value={performance.profitFactor == null ? '—' : performance.profitFactor.toFixed(2)} />
              <Metric label="History period" value={performance.periodStartedAt && performance.periodEndedAt ? `${new Date(performance.periodStartedAt).toLocaleDateString()} – ${new Date(performance.periodEndedAt).toLocaleDateString()}` : '—'} />
            </dl>
          </Card>
        </div>
        <Card className="xl:sticky xl:top-4">
          <h2 className="text-sm font-semibold">Overview</h2>
          <dl className="mt-4 space-y-3">
            <Metric label="Account environment" value={performance.accountMode.toUpperCase()} />
            <Metric label="Return" value="—" />
            <Metric label="Maximum drawdown" value="—" />
            <Metric label="Equity curve" value="—" />
            <Metric label="Calculated" value={when(performance.calculatedAt)} />
          </dl>
          <p className="mt-4 text-xs leading-5 text-neutral-500">Returns, drawdown and an equity curve remain unavailable because cash-flow and periodic equity history do not yet support defensible calculations.</p>
        </Card>
      </div>
    ) : null}
    {tab === 'trading' ? <div className="space-y-4">{open.length > 0 ? <Card padding="none" className="overflow-hidden"><h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold dark:border-neutral-800">Open positions ({open.length})</h2><TradeRows rows={open} /></Card> : <Card><p className="text-sm text-neutral-500">No open positions are recorded for this source.</p></Card>}{closed.length > 0 ? <Card padding="none" className="overflow-hidden"><h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold dark:border-neutral-800">Closed trades ({closed.length})</h2><TradeRows rows={closed} /></Card> : <Card><p className="text-sm text-neutral-500">No qualifying closed history is recorded for this source.</p></Card>}</div> : null}
    {tab === 'portfolio' ? <Card><h2 className="text-sm font-semibold">Portfolio history unavailable</h2><p className="mt-2 text-sm leading-6 text-neutral-500">The approved preview's balance and equity charts require periodic broker equity snapshots. They are intentionally unavailable until the backend can substantiate them.</p></Card> : null}
    <p className="text-xs leading-5 text-neutral-500">Metrics and rows include only TSCopier-recorded trades attributed to this selected source account. Destination-side copy executions are excluded. Broker account identifiers and credentials are never shown.</p>
  </div>
}
