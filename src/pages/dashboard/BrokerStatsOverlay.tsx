import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { RefreshCw, X } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { formatMoneyWithCode } from '../../lib/currency'
import { interpolate } from '../../i18n/interpolate'
import { usePerformanceData } from '../../hooks/usePerformanceData'
import { useFxsocketStream } from '../../hooks/useFxsocketStream'
import { computeBrokerStatsSnapshot } from '../../lib/brokerStats'
import {
  type BrokerStatsRouteState,
} from '../../lib/brokerStatsNavigation'
import {
  inferBrokerLabelFromServer,
  resolveAccountLogin,
  resolveLinkedAccountType,
  resolveMtServerCandidate,
} from '../../lib/brokerFromServer'
import { brokerConnectionStatusLabel } from '../../lib/brokerReconnect'
import { isFxsocketLinkedBroker } from '../../lib/brokerLink'
import { mergeLivePositionsIntoMtTrades } from '../../lib/mergeLivePositionsIntoMtTrades'
import {
  isFxsocketMarketPositionRow,
  unwrapFxsocketPositionsPayload,
} from '../../lib/fxsocketStreamParse'
import { Button } from '../../components/ui/Button'
import type { BrokerAccount } from '../../types/database'

function readPositionTicket(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  for (const key of ['ticket', 'Ticket', 'id', 'Id', 'positionId', 'PositionId']) {
    const v = o[key]
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function upsertLivePositionRow(
  prev: Map<number, Record<string, unknown>>,
  raw: unknown,
): Map<number, Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return prev
  const row = raw as Record<string, unknown>
  const ticket = readPositionTicket(row)
  if (ticket == null) return prev

  const state = String(row.state ?? row.State ?? '').toLowerCase()
  const volume = Number(row.volume ?? row.Volume ?? row.lots ?? row.Lots ?? 1)
  const closed =
    state.includes('closed')
    || state.includes('cancel')
    || state.includes('deleted')
    || volume === 0
    || !isFxsocketMarketPositionRow(row)

  const next = new Map(prev)
  if (closed) {
    if (!next.has(ticket)) return prev
    next.delete(ticket)
    return next
  }
  if (prev.get(ticket) === row) return prev
  next.set(ticket, row)
  return next
}

function rebuildLivePositionRows(rawData: unknown): Map<number, Record<string, unknown>> {
  const rows = unwrapFxsocketPositionsPayload(rawData)
  const next = new Map<number, Record<string, unknown>>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || !isFxsocketMarketPositionRow(raw)) continue
    const ticket = readPositionTicket(raw)
    if (ticket != null) next.set(ticket, raw as Record<string, unknown>)
  }
  return next
}

function formatPct(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

function StatTile({
  label,
  hint,
  value,
  valueClassName,
}: {
  label: string
  hint?: string
  value: string
  valueClassName?: string
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50/80 p-3 dark:border-neutral-800 dark:bg-neutral-800/40">
      <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400" title={hint}>
        {label}
      </p>
      <p className={clsx('mt-1 text-lg font-semibold tabular-nums', valueClassName ?? 'text-neutral-900 dark:text-neutral-50')}>
        {value}
      </p>
    </div>
  )
}

function HeaderSkeleton() {
  return (
    <div className="min-w-0 space-y-2 animate-pulse">
      <div className="h-5 w-40 rounded bg-neutral-200 dark:bg-neutral-700" />
      <div className="h-3 w-28 rounded bg-neutral-100 dark:bg-neutral-800" />
      <div className="h-3 w-56 rounded bg-neutral-100 dark:bg-neutral-800" />
    </div>
  )
}

export function BrokerStatsOverlay() {
  const { brokerId } = useParams<{ brokerId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const routePreview = (location.state as BrokerStatsRouteState | null)?.accountPreview
  const { user } = useAuth()
  const t = useT()
  const bs = t.dashboard.brokerStats
  const la = t.dashboard.linkedAccounts
  const { formatSignedMoney } = useFormatMoney()

  const {
    accounts,
    mtTrades,
    chartTrades,
    balanceByAccountId,
    equityByAccountId,
    channelLinkMaps,
    perAccountPerformance,
    loading,
    refreshing,
    error,
    refresh,
    refreshBroker,
  } = usePerformanceData(user?.id)

  const account = useMemo((): BrokerAccount | null => {
    if (!brokerId) return null
    const loaded = accounts.find(a => a.id === brokerId)
    if (loaded) return loaded
    if (routePreview?.id === brokerId) return routePreview as BrokerAccount
    return null
  }, [accounts, brokerId, routePreview])

  const headerReady = account != null

  const close = () => navigate('/dashboard')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/dashboard')
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [navigate])

  const liveRefreshKeyRef = useRef<string | null>(null)
  const [brokerMetricsReady, setBrokerMetricsReady] = useState(false)
  const [livePositionRows, setLivePositionRows] = useState<Map<number, Record<string, unknown>>>(
    () => new Map(),
  )

  useEffect(() => {
    liveRefreshKeyRef.current = null
    setBrokerMetricsReady(false)
    setLivePositionRows(new Map())
  }, [brokerId])

  const streamBrokers = useMemo(
    () => (account && isFxsocketLinkedBroker(account) ? [account] : []),
    [account],
  )

  useFxsocketStream(streamBrokers, {
    onPositions: (_brokerId, _snapshot, rawData) => {
      setLivePositionRows(rebuildLivePositionRows(rawData))
    },
    onTrade: (_brokerId, data) => {
      setLivePositionRows(prev => upsertLivePositionRow(prev, data))
    },
  }, streamBrokers.length > 0)

  useEffect(() => {
    if (!brokerId || !user?.id) return

    const loaded = accounts.find(a => a.id === brokerId)
    if (!loaded) return

    if (!isFxsocketLinkedBroker(loaded)) {
      setBrokerMetricsReady(true)
      return
    }

    const key = `${brokerId}:${user.id}`
    if (liveRefreshKeyRef.current === key) return
    liveRefreshKeyRef.current = key
    void refreshBroker(brokerId, { silent: true }).finally(() => setBrokerMetricsReady(true))
  }, [brokerId, user?.id, accounts, refreshBroker])

  const currency = (account?.last_currency ?? '').trim() || undefined

  const effectiveMtTrades = useMemo(() => {
    if (!account || livePositionRows.size === 0) return mtTrades
    return mergeLivePositionsIntoMtTrades(mtTrades, account, livePositionRows.values())
  }, [mtTrades, account, livePositionRows])

  const stats = useMemo(() => {
    if (!brokerId || !account) return null
    return computeBrokerStatsSnapshot({
      brokerId,
      initialBalance: account.performance_baseline_balance,
      currentBalance: balanceByAccountId[brokerId] ?? account.last_balance,
      currentEquity: equityByAccountId[brokerId] ?? account.last_equity,
      mtTrades: effectiveMtTrades,
      chartTrades,
      channelLinkMaps,
      connectedChannelIds: account.signal_channel_ids,
      unlinkedChannelLabel: t.performance.unlinkedChannel,
    })
  }, [
    brokerId,
    account,
    balanceByAccountId,
    equityByAccountId,
    effectiveMtTrades,
    chartTrades,
    channelLinkMaps,
    t.performance.unlinkedChannel,
  ])

  const perf = brokerId ? perAccountPerformance[brokerId] : undefined

  const brokerLabel =
    account?.broker_name?.trim() ||
    inferBrokerLabelFromServer(account?.broker_server ?? '') ||
    '—'
  const accountLabel = account?.label?.trim() || (headerReady ? la.unnamedAccount : '')
  const platform = (account?.platform ?? '').trim().toUpperCase() || '—'
  const login = account ? resolveAccountLogin(account) : ''
  const platformLine = login ? `${platform} • ${login}` : platform
  const accountType = account
    ? resolveLinkedAccountType(undefined, resolveMtServerCandidate(account, account.broker_server)) ?? '—'
    : '—'
  const accountTypeLabel =
    accountType === 'Live'
      ? la.accountTypeLive
      : accountType === 'Demo'
        ? la.accountTypeDemo
        : accountType

  const pnlColor = (n: number) =>
    n > 0 ? 'text-teal-600' : n < 0 ? 'text-error-600' : 'text-neutral-900 dark:text-neutral-50'

  const needsLiveBrokerHistory = account != null && isFxsocketLinkedBroker(account)
  const showBodySkeleton = !stats && (loading || (needsLiveBrokerHistory && !brokerMetricsReady))
  const showRefreshingOverlay = Boolean(stats && needsLiveBrokerHistory && !brokerMetricsReady)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="broker-stats-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-900/50 backdrop-blur-sm"
        aria-label={bs.close}
        onClick={close}
      />
      <div className="relative w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white/95 dark:bg-neutral-900/95 backdrop-blur">
          {headerReady ? (
            <div className="min-w-0">
              <h2 id="broker-stats-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 truncate">
                {accountLabel}
              </h2>
              <p className="text-xs text-primary-600 font-medium uppercase tabular-nums">{platformLine}</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                {brokerLabel}
                {account ? (
                  <>
                    {' · '}
                    <span
                      className={clsx(
                        'font-semibold',
                        accountType === 'Live' && 'text-teal-700 dark:text-teal-300',
                        accountType === 'Demo' && 'text-amber-700 dark:text-amber-300',
                      )}
                    >
                      {accountTypeLabel}
                    </span>
                    {' · '}
                    {brokerConnectionStatusLabel(account, la)}
                  </>
                ) : null}
              </p>
            </div>
          ) : (
            <HeaderSkeleton />
          )}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              loading={refreshing}
              disabled={(loading && !stats) || refreshing}
              onClick={() => {
                if (brokerId) void refreshBroker(brokerId)
                else void refresh()
              }}
              aria-label={bs.refresh}
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <button
              type="button"
              className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              aria-label={bs.close}
              onClick={close}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-6">
          {error ? (
            <p className="text-sm text-error-600 dark:text-error-400">{error}</p>
          ) : null}

          {!account && !loading ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 py-8 text-center">{bs.notFound}</p>
          ) : null}

          {showBodySkeleton ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 animate-pulse">
              {[...Array(9)].map((_, i) => (
                <div key={i} className="h-[72px] rounded-xl bg-neutral-100 dark:bg-neutral-800" />
              ))}
            </div>
          ) : account && stats ? (
            <>
              <section
                className={clsx(
                  'grid grid-cols-2 sm:grid-cols-3 gap-3 transition-opacity',
                  showRefreshingOverlay && 'opacity-60',
                )}
              >
                <StatTile
                  label={bs.initialBalance}
                  hint={bs.initialBalanceHint}
                  value={formatMoneyWithCode(stats.initialBalance, currency)}
                />
                <StatTile
                  label={bs.currentBalance}
                  value={formatMoneyWithCode(stats.currentBalance, currency)}
                />
                <StatTile
                  label={bs.currentEquity}
                  value={formatMoneyWithCode(stats.currentEquity, currency)}
                />
                <StatTile
                  label={bs.totalProfit}
                  hint={bs.totalProfitHint}
                  value={formatSignedMoney(stats.totalProfit)}
                  valueClassName={pnlColor(stats.totalProfit)}
                />
                <StatTile
                  label={bs.todayProfit}
                  hint={bs.todayProfitHint}
                  value={formatSignedMoney(stats.todayProfit)}
                  valueClassName={pnlColor(stats.todayProfit)}
                />
                <StatTile
                  label={bs.winRate}
                  value={formatPct(perf?.winRate, 0)}
                />
                <StatTile
                  label={bs.maxDrawdown}
                  value={formatPct(perf?.maxDrawdownPct)}
                />
                <StatTile
                  label={bs.roi}
                  value={
                    perf?.roi != null && Number.isFinite(perf.roi)
                      ? `${perf.roi > 0 ? '+' : ''}${perf.roi.toFixed(1)}%`
                      : '—'
                  }
                  valueClassName={
                    perf?.roi != null
                      ? pnlColor(perf.roi)
                      : 'text-neutral-900 dark:text-neutral-50'
                  }
                />
                <StatTile
                  label={bs.closedDeals}
                  value={String(stats.closedDealCount)}
                />
              </section>

              <section>
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{bs.connectedChannels}</h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{bs.connectedChannelsHint}</p>
                {stats.profitByChannel.length === 0 ? (
                  <p className="mt-3 text-sm text-neutral-400 dark:text-neutral-500">{bs.noChannels}</p>
                ) : (
                  <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-800 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                    {stats.profitByChannel.map(row => (
                      <li
                        key={row.key}
                        className="flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-neutral-900"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{row.label}</p>
                          <p className="text-xs text-neutral-400">{interpolate(bs.tradesCount, { count: String(row.count) })}</p>
                        </div>
                        <span className={clsx('text-sm font-semibold tabular-nums shrink-0', pnlColor(row.pnl))}>
                          {formatSignedMoney(row.pnl)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4">
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{bs.activeSignalTrade}</h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{bs.activeSignalTradeHint}</p>
                {stats.activeSignalTrades.length === 0 ? (
                  <p className="mt-3 text-sm text-neutral-400 dark:text-neutral-500">{bs.noActiveSignalTrade}</p>
                ) : (
                  <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-800 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
                    {stats.activeSignalTrades.map(row => (
                      <li
                        key={row.channelId}
                        className="flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-neutral-900"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">
                            {row.channelLabel}
                          </p>
                          <p className="text-xs text-neutral-400 mt-0.5 tabular-nums">
                            {row.totalLots > 0 ? `${row.totalLots.toFixed(2)} ${bs.lots}` : '—'}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-[10px] uppercase tracking-wide text-neutral-400">{bs.openPnl}</p>
                          <p className={clsx('text-sm font-semibold tabular-nums', pnlColor(row.pnl))}>
                            {formatSignedMoney(row.pnl)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4">
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{bs.lastSignalTrade}</h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{bs.lastSignalTradeHint}</p>
                {stats.lastSignalTrade ? (
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <p className="text-xs text-neutral-400">{bs.channel}</p>
                      <p className="font-medium text-neutral-900 dark:text-neutral-50 truncate">
                        {stats.lastSignalTrade.channelLabel}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-neutral-400">{bs.symbol}</p>
                      <p className="font-medium text-neutral-900 dark:text-neutral-50">{stats.lastSignalTrade.symbol}</p>
                    </div>
                    <div>
                      <p className="text-xs text-neutral-400">{bs.lastSignalChannelProfit}</p>
                      <p className={clsx('font-semibold tabular-nums', pnlColor(stats.lastSignalTrade.pnl))}>
                        {formatSignedMoney(stats.lastSignalTrade.pnl)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-neutral-400">{bs.closedAt}</p>
                      <p className="font-medium text-neutral-900 dark:text-neutral-50 tabular-nums">
                        {new Date(stats.lastSignalTrade.closedAt).toLocaleString([], {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-neutral-400 dark:text-neutral-500">{bs.noLastSignalTrade}</p>
                )}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
