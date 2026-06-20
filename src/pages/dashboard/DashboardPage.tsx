import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { Link, Outlet, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, Clock, Loader2, Plus, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import type { BrokerAccount, Signal, Trade } from '../../types/database'
import {
  inferBrokerLabelFromServer,
  resolveAccountLogin,
  resolveLinkedAccountTypeForBroker,
  resolveMtServerCandidate,
  formatLinkedAccountTypeLabel,
  linkedAccountTypeValueClass,
  type LinkedAccountType,
} from '../../lib/brokerFromServer'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { Toggle } from '../../components/ui/Toggle'
import { Button } from '../../components/ui/Button'
import { InfoTooltip } from '../../components/ui/InfoTooltip'
import { fxsocketBroker, type MtTrade } from '../../lib/fxsocketBroker'
import { isFxsocketLinkedBroker, countLinkedBrokerSessions } from '../../lib/brokerLink'
import { resolveBrokerTotalBalance } from '../../lib/effectiveBrokerBalance'
import { useFxsocketStream } from '../../hooks/useFxsocketStream'
import {
  rebuildPositionBookFromPayload,
  rebuildPositionBookFromMtTrades,
  mergePositionRowIntoBook,
  snapshotFromPositionBook,
  type FxsocketPositionBook,
} from '../../lib/fxsocketLivePositionBook'
import {
  countOpenMarketPositionsByBroker,
  isFxsocketMarketPositionRow,
  parseFxsocketAccountStreamData,
  resolveFxsocketFloatingOpenPnl,
  sumOpenPnlByBroker,
  unwrapFxsocketPositionsPayload,
  type FxsocketAccountStreamSnapshot,
} from '../../lib/fxsocketStreamParse'
import { formatLocalCalendarDay } from '../../lib/dayStartBalance'
import { isMtTimestampInRange } from '../../lib/mtApiDateTime'
import {
  aggregateRealizedProfitFromTrades,
  computeLinkedAccountPerformanceMap,
  getLocalCalendarDayBounds,
  isTradeableClosedRow,
  netClosedLegProfit,
  type LinkedAccountPerformance,
  type TradeStatsRow,
} from '../../lib/dashboardTradeStats'
import { filterMtTradesSinceConnect } from '../../lib/tradesSinceConnect'
import {
  buildCopierLogSymbolLabels,
  buildSignalSymbolLookup,
} from '../../lib/copierLogDisplay'
import { buildDisplayableTradeActivities, buildChannelDisplayNames, dedupePipelineParseAttempts, type TradeActivityLogRow } from '../../lib/tradeActivities'
import { TradeActivityCard } from '../../components/dashboard/TradeActivityCard'
import {
  DASHBOARD_ACTIVE_USER_KEY,
  DASHBOARD_CACHE_LEGACY_KEYS,
  DASHBOARD_CACHE_VERSION,
  clearDashboardSessionCache,
  getDashboardActiveUserId,
  isDashboardSessionLoaded,
  markDashboardSessionLoaded,
  readDashboardMemoryCache,
  resolveDashboardCacheUserId,
  setDashboardActiveUserId,
  writeDashboardMemoryCache,
} from '../../lib/dashboardSessionCache'
import { brokerStatsPreviewFromAccount } from '../../lib/brokerStatsNavigation'
import { buildPortfolioActiveSignalGroups, computeConnectPnlByAccountId } from '../../lib/brokerStats'
import { OpenPnlAccountsModal } from '../../components/dashboard/OpenPnlAccountsModal'
import { syncPerformanceCacheFromDashboard } from '../../lib/performanceCacheBridge'
import { fetchBrokerMtTrades } from '../../lib/brokerTradeHistory'
import {
  resolveDashboardChartTrades,
  type DashboardChartTrade,
} from '../../lib/dashboardCharts'
import {
  deriveDashboardAnalytics,
  preferAuthoritativeChartTrades,
  resolveAnalyticsChartTrades,
  type DashboardAnalytics,
} from '../../lib/dashboardAnalytics'
import {
  buildPerformanceChannelLinkMaps,
  EMPTY_CHANNEL_LINK_MAPS,
  normalizeChannelLinkMaps,
  type PerformanceChannelLinkMaps,
} from '../../lib/performanceInsights'
import { ChannelProfitChart } from '../../components/dashboard/ChannelProfitChart'
import { TradeVolumeChart } from '../../components/dashboard/TradeVolumeChart'
import { useDashboardRealtime } from '../../hooks/useDashboardRealtime'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import {
  sortBrokerAccountsNewestFirst,
} from '../../lib/brokerAccountSelect'
import {
  brokerCanReconnect,
  brokerConnectionStatusLabel,
  isBrokerSessionConnected,
} from '../../lib/brokerReconnect'
import {
  brokerConnectErrorLabelsFromI18n,
  brokerReconnectBannerText,
} from '../../lib/brokerConnectError'
import { useLocale, useT } from '../../context/LocaleContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { lossTextClass, pnlSignTextClass } from '../../lib/pnlDisplay'
import { formatMoneyWithCode } from '../../lib/currency'
import { interpolate } from '../../i18n/interpolate'
import { SubscriptionBanner } from '../../components/billing/SubscriptionBanner'
import { TelegramConnectBanner } from '../../components/dashboard/TelegramConnectBanner'
import {
  sortLinkedAccounts,
  type LinkedAccountSortKey,
  type SortDirection,
} from '../../lib/linkedAccountSort'

const DASHBOARD_MT_HISTORY_LIMIT = 5000
/** Keep spinner visible briefly after load completes so charts/metrics can paint. */
const DASHBOARD_METRICS_LOADER_DISMISS_MS = 5_000

/** Shared column template for dashboard Copier Logs header + rows. */
const DASHBOARD_COPIER_LOG_GRID =
  'grid grid-cols-[5.75rem_minmax(0,1fr)_minmax(4rem,0.85fr)_minmax(4.75rem,auto)_minmax(6.75rem,auto)] gap-x-3 items-center'

function isNonTradeSkipReason(value: string | null | undefined): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  return normalized === 'non_trade_message'
}

interface DashboardStats {
  accounts: number
  portfolioValue: number
  totalEquity: number
  tradesTaken: number
  tradesTakenYesterday: number
  tradesWon: number
  tradesLost: number
  tradesBreakeven: number
  openPnl: number
  openPositions: number
  openTrades: number
  tradesCopiedToday: number
  activeChannels: number
  copierHealth: 'Stable' | 'Degraded' | 'Offline'
  totalSignals: number
  yesterdayTotalSignals: number
  totalVolume: number
  yesterdayTotalVolume: number
  /** Sum of `profit` across all trades (open floating + closed realized) — account-level P/L from the trade list. */
  /** Sum of realized closed-deal profit across linked accounts (deposits excluded). */
  totalProfitLoss: number | null
  /** Unused for Total P/L (lifetime-style metric has no single yesterday twin); keep null so the UI hides the sub. */
  yesterdayTotalProfitLoss: number | null
  /** Largest profit among trades closed today with strictly positive P/L; 0 if none. */
  bestTradeProfit: number
  yesterdayBestTradeProfit: number
  /** Most negative profit among trades closed today; 0 if none. */
  worstTradeProfit: number
  yesterdayWorstTradeProfit: number
  todayProfit: number
  yesterdayProfit: number
  mostProfitableChannel: string
  yesterdayMostProfitableChannel: string
  mostTradedAsset: string
  yesterdayMostTradedAsset: string
}

interface AiExpertLogRow extends TradeActivityLogRow {}

type ChannelNameRow = { id: string; display_name: string; channel_username?: string | null }

function channelLabel(channelId: string | null | undefined, names: Record<string, string>): string {
  if (!channelId) return '—'
  return names[channelId] ?? 'Unknown channel'
}

function mtTradesToStatsByAccount(trades: MtTrade[]): Record<string, TradeStatsRow[]> {
  const out: Record<string, TradeStatsRow[]> = {}
  for (const t of trades) {
    const accountId = String(t.broker_id ?? '').trim()
    if (!accountId) continue
    const row: TradeStatsRow = {
      status: t.status,
      profit: t.profit,
      closed_at: t.closed_at,
      opened_at: t.opened_at,
      symbol: t.symbol,
      lot_size: t.lot_size,
      direction: t.direction,
      type: t.type,
      swap: t.swap,
      commission: t.commission,
    }
    const list = out[accountId] ?? []
    list.push(row)
    out[accountId] = list
  }
  return out
}

function aggregateTotalProfitFromMtTrades(
  accounts: BrokerAccount[],
  mtTrades: MtTrade[] | null | undefined,
): number | null {
  if (!mtTrades?.length) return null
  return aggregateRealizedProfitFromTrades(accounts, mtTradesToStatsByAccount(mtTrades))
}

function hasActiveMtBroker(accounts: BrokerAccount[]): boolean {
  return accounts.some(isFxsocketLinkedBroker)
}

type BrokerBalanceSnapshot = {
  balance?: number
  equity?: number
  currency?: string
  broker?: string
  mt_server_hint?: string
  account_type?: LinkedAccountType
  open_pnl?: number
  open_trades?: number
}

function isBrokerLiveConnected(
  account: Pick<BrokerAccount, 'fxsocket_status' | 'connection_status'>,
): boolean {
  return isBrokerSessionConnected(account)
}

/** WS-active brokers count as live even before DB status catches up. */
function isBrokerLiveForMetrics(
  account: BrokerAccount,
  wsLiveBrokerIds: ReadonlySet<string>,
): boolean {
  return wsLiveBrokerIds.has(account.id) || isBrokerLiveConnected(account)
}

/** Floating P/L on open positions for one linked account (live broker feed). */
function resolveAccountOpenPnl(
  account: BrokerAccount,
  accountSummary?: { balance?: number; equity?: number; open_pnl?: number },
): number | null {
  const fromSummary = accountSummary?.open_pnl
  if (fromSummary != null && Number.isFinite(fromSummary)) return fromSummary
  if (!isBrokerLiveConnected(account)) return null
  const balance = accountSummary?.balance ?? account.last_balance
  const equity = accountSummary?.equity ?? account.last_equity
  if (balance != null && equity != null && Number.isFinite(balance) && Number.isFinite(equity)) {
    return equity - balance
  }
  return null
}

function hasConnectedBrokerOpenPnl(
  accounts: BrokerAccount[],
  balances: Record<string, BrokerBalanceSnapshot>,
  wsLiveBrokerIds: ReadonlySet<string> = new Set(),
): boolean {
  return accounts.some(
    account =>
      isBrokerLiveForMetrics(account, wsLiveBrokerIds) && balances[account.id]?.open_pnl != null,
  )
}

/** Recompute headline balance/equity/open stats from the live balance map (WS + DB seed). */
function recomputeLiveBrokerDashboardStats(
  accounts: BrokerAccount[],
  balances: Record<string, BrokerBalanceSnapshot>,
  prev: DashboardStats,
  wsLiveBrokerIds: ReadonlySet<string> = new Set(),
): Pick<DashboardStats, 'portfolioValue' | 'totalEquity' | 'openPnl' | 'openTrades' | 'openPositions'> {
  let portfolioValue = 0
  let totalEquity = 0
  let openPnl = 0

  for (const account of accounts) {
    const snap = balances[account.id]
    if (snap?.balance != null && Number.isFinite(snap.balance)) {
      portfolioValue += snap.balance
    }
    if (snap?.equity != null && Number.isFinite(snap.equity)) {
      totalEquity += snap.equity
    } else if (snap?.balance != null && Number.isFinite(snap.balance)) {
      totalEquity += snap.balance
    }
    if (isBrokerLiveForMetrics(account, wsLiveBrokerIds)) {
      const p = snap?.open_pnl
      if (p != null && Number.isFinite(p)) openPnl += p
    }
  }

  const hasOpenTrades = hasConnectedBrokerOpenTrades(accounts, balances, wsLiveBrokerIds)
  const openTrades = accounts.some(isFxsocketLinkedBroker)
    ? sumConnectedOpenTrades(accounts, balances, wsLiveBrokerIds)
    : hasOpenTrades
      ? sumConnectedOpenTrades(accounts, balances, wsLiveBrokerIds)
      : prev.openTrades
  const hasOpenPnl = hasConnectedBrokerOpenPnl(accounts, balances, wsLiveBrokerIds)

  return {
    portfolioValue,
    totalEquity,
    openPnl: hasOpenPnl ? openPnl : prev.openPnl,
    openTrades,
    openPositions: openTrades,
  }
}

function applyFxsocketAccountStreamUpdate(
  brokerId: string,
  snap: FxsocketAccountStreamSnapshot,
  prev: Record<string, BrokerBalanceSnapshot>,
): Record<string, BrokerBalanceSnapshot> {
  return {
    ...prev,
    [brokerId]: {
      ...(prev[brokerId] ?? {}),
      ...(snap.balance != null ? { balance: snap.balance } : {}),
      ...(snap.equity != null ? { equity: snap.equity } : {}),
      ...(snap.openPnl != null ? { open_pnl: snap.openPnl } : {}),
      ...(snap.currency ? { currency: snap.currency } : {}),
    },
  }
}

/** Sum open positions only from brokers with a live connected session. */
function sumConnectedOpenTrades(
  accounts: BrokerAccount[],
  balances: Record<string, BrokerBalanceSnapshot>,
  wsLiveBrokerIds: ReadonlySet<string> = new Set(),
): number {
  return accounts.reduce((sum, account) => {
    if (!isBrokerLiveForMetrics(account, wsLiveBrokerIds)) return sum
    const n = balances[account.id]?.open_trades
    return sum + (typeof n === 'number' && Number.isFinite(n) ? n : 0)
  }, 0)
}

/**
 * Open-trade headline count: FxSocket-linked accounts use live broker feeds only
 * (WebSocket positions or REST bootstrap). Never stale TScopier DB leg rows.
 */
function resolveDashboardOpenTradesCount(
  accounts: BrokerAccount[],
  balances: Record<string, BrokerBalanceSnapshot>,
  dbOpenCount: number,
): number {
  if (accounts.some(isFxsocketLinkedBroker)) {
    return sumConnectedOpenTrades(accounts, balances)
  }
  if (hasConnectedBrokerOpenTrades(accounts, balances)) {
    return sumConnectedOpenTrades(accounts, balances)
  }
  return dbOpenCount
}

function hasConnectedBrokerOpenTrades(
  accounts: BrokerAccount[],
  balances: Record<string, BrokerBalanceSnapshot>,
  wsLiveBrokerIds: ReadonlySet<string> = new Set(),
): boolean {
  return accounts.some(
    account =>
      isBrokerLiveForMetrics(account, wsLiveBrokerIds)
      && typeof balances[account.id]?.open_trades === 'number',
  )
}

/** Connected brokers with at least one open position (live summary or MT trade list). */
function countAccountsWithOpenPositions(
  accounts: BrokerAccount[],
  balances: Record<string, BrokerBalanceSnapshot>,
  mtTrades: MtTrade[] | null | undefined,
): number {
  const fromLive = accounts.filter(account => {
    if (!isBrokerLiveConnected(account)) return false
    const openTrades = balances[account.id]?.open_trades
    if (typeof openTrades === 'number' && openTrades > 0) return true
    const openPnl = balances[account.id]?.open_pnl
    return typeof openPnl === 'number' && Number.isFinite(openPnl) && openPnl !== 0
  }).length
  if (fromLive > 0) return fromLive

  if (!mtTrades?.length) return 0
  const brokers = new Set<string>()
  for (const t of mtTrades) {
    if (t.status === 'open' && t.broker_id) brokers.add(t.broker_id)
  }
  return brokers.size
}

/** Keep live MT equity/open stats when a quiet DB refresh would overwrite them. */
function mergeBrokerBalances(
  fromDb: Record<string, BrokerBalanceSnapshot>,
  prev: Record<string, BrokerBalanceSnapshot>,
  sticky: Record<string, { open_pnl?: number; open_trades?: number }>,
  accounts: BrokerAccount[],
  wsLiveBrokerIds: ReadonlySet<string> = new Set(),
): Record<string, BrokerBalanceSnapshot> {
  const connected = new Set(
    accounts.filter(a => isBrokerLiveForMetrics(a, wsLiveBrokerIds)).map(a => a.id),
  )
  const out: Record<string, BrokerBalanceSnapshot> = { ...fromDb }
  for (const id of new Set([...Object.keys(fromDb), ...Object.keys(prev)])) {
    const db = fromDb[id]
    const old = prev[id]
    const st = sticky[id]
    if (!db && !old) continue
    const liveOk = connected.has(id)
    out[id] = {
      ...(db ?? {}),
      balance: old?.balance ?? db?.balance,
      equity: old?.equity ?? db?.equity,
      currency: db?.currency ?? old?.currency,
      broker: db?.broker ?? old?.broker,
      mt_server_hint: db?.mt_server_hint ?? old?.mt_server_hint,
      account_type: db?.account_type ?? old?.account_type,
      open_pnl: liveOk ? (st?.open_pnl ?? old?.open_pnl ?? db?.open_pnl) : 0,
      open_trades: liveOk ? (st?.open_trades ?? old?.open_trades ?? db?.open_trades) : 0,
    }
  }
  return out
}

type DashboardCachePayload = {
  stats: DashboardStats
  copierLogs: Signal[]
  copierLogSymbols: Record<string, string>
  channelDisplayNames: Record<string, string>
  linkedAccounts: BrokerAccount[]
  linkedAccountBalances: Record<string, BrokerBalanceSnapshot>
  chartTrades?: DashboardChartTrade[]
  aiExpertLogs?: AiExpertLogRow[]
  mtTrades?: MtTrade[]
  channelLinkMaps?: PerformanceChannelLinkMaps
  cachedAnalytics?: DashboardAnalytics
  cachedDay?: string
  cachedAt?: number
}

const DEFAULT_DASHBOARD_STATS: DashboardStats = {
  accounts: 0,
  portfolioValue: 0,
  totalEquity: 0,
  tradesTaken: 0,
  tradesTakenYesterday: 0,
  tradesWon: 0,
  tradesLost: 0,
  tradesBreakeven: 0,
  openPnl: 0,
  openPositions: 0,
  openTrades: 0,
  tradesCopiedToday: 0,
  activeChannels: 0,
  copierHealth: 'Stable',
  totalSignals: 0,
  yesterdayTotalSignals: 0,
  totalVolume: 0,
  yesterdayTotalVolume: 0,
  totalProfitLoss: null,
  yesterdayTotalProfitLoss: null,
  bestTradeProfit: 0,
  yesterdayBestTradeProfit: 0,
  worstTradeProfit: 0,
  yesterdayWorstTradeProfit: 0,
  todayProfit: 0,
  yesterdayProfit: 0,
  mostProfitableChannel: '—',
  yesterdayMostProfitableChannel: '—',
  mostTradedAsset: '—',
  yesterdayMostTradedAsset: '—',
}

function readBootstrapDashboardCache(authUserId?: string | null): DashboardCachePayload | null {
  const userId = resolveDashboardCacheUserId(authUserId)
  if (!userId) return null
  if (authUserId && userId !== authUserId) return null

  const memory = readDashboardMemoryCache<DashboardCachePayload>(userId)
  if (memory?.stats) return memory

  const fromStorage = readDashboardCache(userId)
  if (fromStorage?.stats) {
    writeDashboardMemoryCache(userId, fromStorage)
  }
  return fromStorage
}

function bootChartTrades(cached: DashboardCachePayload | null): DashboardChartTrade[] {
  if (!cached) return []
  if (cached.chartTrades?.length) return cached.chartTrades
  if (cached.mtTrades?.length) return resolveDashboardChartTrades(cached.mtTrades, [])
  return []
}


function bootDashboardChartsReady(cached: DashboardCachePayload | null): boolean {
  if (!cached?.stats) return false
  if (hasDashboardAnalyticsData(cached.cachedAnalytics)) return true
  if (bootChartTrades(cached).length > 0 || (cached.mtTrades?.length ?? 0) > 0) return true
  return !cached.linkedAccounts?.some(isFxsocketLinkedBroker)
}

function isDashboardBootReady(cached: DashboardCachePayload | null): boolean {
  return Boolean(cached?.stats && bootDashboardChartsReady(cached))
}

function DashboardMetricsLoader({ message }: { message: string }) {
  return (
    <div
      className="flex min-h-[min(70vh,640px)] flex-col items-center justify-center gap-4 px-6 py-16"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <Loader2 className="h-9 w-9 animate-spin text-teal-600 dark:text-teal-400" aria-hidden />
      <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300 text-center max-w-sm">
        {message}
      </p>
    </div>
  )
}

function hasDashboardAnalyticsData(analytics: DashboardAnalytics | null | undefined): boolean {
  if (!analytics) return false
  return analytics.tradeVolume7Day.some(d => d.profit !== 0 || d.loss !== 0 || d.volume > 0)
    || analytics.channelProfit7d.length > 0
    || analytics.tradesTaken > 0
    || analytics.todayProfit !== 0
}

function computeDashboardAnalyticsSnapshot(
  chartTrades: DashboardChartTrade[],
  mtTrades: MtTrade[],
  channelLinkMaps: PerformanceChannelLinkMaps,
  unlinkedLabel: string,
  accounts?: readonly BrokerAccount[],
): DashboardAnalytics {
  return deriveDashboardAnalytics({
    chartTrades,
    mtTrades,
    channelLinkMaps,
    unlinkedLabel,
    accounts,
  })
}

function mergeDashboardCachePayload(
  incoming: DashboardCachePayload,
  existing: DashboardCachePayload | null,
): DashboardCachePayload {
  const chartTrades = incoming.chartTrades?.length ? incoming.chartTrades : existing?.chartTrades
  const mtTrades = incoming.mtTrades?.length ? incoming.mtTrades : existing?.mtTrades
  const channelLinkMaps = (() => {
    const raw = incoming.channelLinkMaps
      && Object.keys(incoming.channelLinkMaps.channelNames ?? {}).length > 0
      ? incoming.channelLinkMaps
      : existing?.channelLinkMaps
    return normalizeChannelLinkMaps(raw)
  })()
  let cachedAnalytics = incoming.cachedAnalytics
  if (!hasDashboardAnalyticsData(cachedAnalytics) && (chartTrades?.length || mtTrades?.length)) {
    cachedAnalytics = computeDashboardAnalyticsSnapshot(
      chartTrades ?? [],
      mtTrades ?? [],
      channelLinkMaps,
      'Unlinked',
      incoming.linkedAccounts,
    )
  }
  if (!hasDashboardAnalyticsData(cachedAnalytics)) {
    cachedAnalytics = existing?.cachedAnalytics ?? cachedAnalytics
  }
  return {
    ...incoming,
    chartTrades,
    mtTrades,
    channelLinkMaps,
    cachedAnalytics,
  }
}

function statsFromDashboardCache(cached: DashboardCachePayload | null): DashboardStats {
  if (!cached?.stats) return DEFAULT_DASHBOARD_STATS
  const accounts = cached.linkedAccounts ?? []
  const balances = cached.linkedAccountBalances ?? {}
  const openTrades = resolveDashboardOpenTradesCount(
    accounts,
    balances,
    hasConnectedBrokerOpenTrades(accounts, balances)
      ? sumConnectedOpenTrades(accounts, balances)
      : cached.stats.openTrades,
  )
  const openPnl = accounts.some(a => isBrokerLiveConnected(a) && balances[a.id]?.open_pnl != null)
    ? accounts.reduce((sum, a) => {
        if (!isBrokerLiveConnected(a)) return sum
        return sum + (balances[a.id]?.open_pnl ?? 0)
      }, 0)
    : cached.stats.openPnl
  return { ...cached.stats, openTrades, openPositions: openTrades, openPnl }
}

/** Avoid flashing DB/empty snapshots over live MT or session-cached figures. */
function mergeDashboardStats(
  prev: DashboardStats,
  next: DashboardStats,
  authoritative: boolean,
  opts?: {
    mtHasClosedTrades?: boolean
    trustOpenTrades?: boolean
    preserveMtTradeCounts?: boolean
    preserveMtPnl?: boolean
  },
): DashboardStats {
  if (authoritative) {
    if (opts?.mtHasClosedTrades === false) {
      return {
        ...prev,
        accounts: next.accounts,
        activeChannels: next.activeChannels,
        tradesCopiedToday: next.tradesCopiedToday,
        copierHealth: next.copierHealth,
        totalSignals: next.totalSignals,
        yesterdayTotalSignals: next.yesterdayTotalSignals,
        ...(opts.trustOpenTrades
          ? { openTrades: next.openTrades, openPositions: next.openPositions, openPnl: next.openPnl }
          : {}),
      }
    }
    return { ...prev, ...next }
  }
  // Balance/equity fields: preserve non-zero to avoid flash during loading
  const keepBalance = (p: number, n: number) => (Number.isFinite(n) && !(n === 0 && p !== 0) ? n : p)
  // Daily stats: always accept fresh value (zero is legitimate at start of day)
  const acceptFresh = (p: number, n: number) => (Number.isFinite(n) ? n : p)
  const keepOpenCount = (p: number, n: number) =>
    opts?.trustOpenTrades ? (Number.isFinite(n) ? n : p) : (Number.isFinite(n) ? n : p)
  const keepStr = (p: string, n: string) => (n === '—' && p !== '—' ? p : n)
  const keepPnl = (p: number, n: number) =>
    opts?.preserveMtPnl && p !== 0 ? p : acceptFresh(p, n)
  const keepTradeCount = (p: number, n: number) =>
    opts?.preserveMtTradeCounts && p !== 0 ? p : acceptFresh(p, n)
  return {
    ...next,
    totalEquity: keepBalance(prev.totalEquity, next.totalEquity),
    portfolioValue: keepBalance(prev.portfolioValue, next.portfolioValue),
    openPnl: keepBalance(prev.openPnl, next.openPnl),
    openPositions: keepOpenCount(prev.openPositions, next.openPositions),
    openTrades: keepOpenCount(prev.openTrades, next.openTrades),
    todayProfit: keepPnl(prev.todayProfit, next.todayProfit),
    yesterdayProfit: keepPnl(prev.yesterdayProfit, next.yesterdayProfit),
    tradesTaken: keepTradeCount(prev.tradesTaken, next.tradesTaken),
    tradesTakenYesterday: keepTradeCount(prev.tradesTakenYesterday, next.tradesTakenYesterday),
    tradesWon: keepTradeCount(prev.tradesWon, next.tradesWon),
    tradesLost: keepTradeCount(prev.tradesLost, next.tradesLost),
    tradesBreakeven: keepTradeCount(prev.tradesBreakeven, next.tradesBreakeven),
    totalVolume: acceptFresh(prev.totalVolume, next.totalVolume),
    yesterdayTotalVolume: acceptFresh(prev.yesterdayTotalVolume, next.yesterdayTotalVolume),
    bestTradeProfit: acceptFresh(prev.bestTradeProfit, next.bestTradeProfit),
    yesterdayBestTradeProfit: acceptFresh(prev.yesterdayBestTradeProfit, next.yesterdayBestTradeProfit),
    worstTradeProfit: acceptFresh(prev.worstTradeProfit, next.worstTradeProfit),
    yesterdayWorstTradeProfit: acceptFresh(prev.yesterdayWorstTradeProfit, next.yesterdayWorstTradeProfit),
    mostTradedAsset: keepStr(prev.mostTradedAsset, next.mostTradedAsset),
    yesterdayMostTradedAsset: keepStr(prev.yesterdayMostTradedAsset, next.yesterdayMostTradedAsset),
    mostProfitableChannel: keepStr(prev.mostProfitableChannel, next.mostProfitableChannel),
    yesterdayMostProfitableChannel: keepStr(
      prev.yesterdayMostProfitableChannel,
      next.yesterdayMostProfitableChannel,
    ),
  }
}

function applyAuthoritativeChartTrades(
  prev: DashboardChartTrade[],
  next: DashboardChartTrade[],
  hasMtBroker: boolean,
): DashboardChartTrade[] {
  return preferAuthoritativeChartTrades(prev, next, { hasMtBroker })
}

function writeDashboardCache(userId: string, payload: DashboardCachePayload) {
  const existing = readDashboardMemoryCache<DashboardCachePayload>(userId) ?? readDashboardCache(userId)
  const merged = mergeDashboardCachePayload(payload, existing)
  const envelope: DashboardCachePayload = {
    ...merged,
    cachedDay: formatLocalCalendarDay(),
    cachedAt: Date.now(),
  }
  writeDashboardMemoryCache(userId, envelope)
  sessionStorage.setItem(DASHBOARD_ACTIVE_USER_KEY, userId)
  const slimForStorage: DashboardCachePayload = {
    ...envelope,
    mtTrades: undefined,
    chartTrades: envelope.chartTrades?.length && JSON.stringify(envelope.chartTrades).length < 400_000
      ? envelope.chartTrades
      : undefined,
  }
  try {
    sessionStorage.setItem(`${DASHBOARD_CACHE_VERSION}:${userId}`, JSON.stringify(slimForStorage))
  } catch {
    try {
      sessionStorage.setItem(`${DASHBOARD_CACHE_VERSION}:${userId}`, JSON.stringify({
        ...slimForStorage,
        chartTrades: undefined,
        copierLogs: slimForStorage.copierLogs?.slice(0, 10),
        aiExpertLogs: slimForStorage.aiExpertLogs?.slice(0, 10),
      }))
    } catch {
      /* memory cache still holds the full snapshot for this tab */
    }
  }
  syncPerformanceCacheFromDashboard(userId)
  markDashboardSessionLoaded(userId)
}

function readDashboardCache(userId: string): DashboardCachePayload | null {
  const keys = [
    `${DASHBOARD_CACHE_VERSION}:${userId}`,
    ...DASHBOARD_CACHE_LEGACY_KEYS.map(v => `${v}:${userId}`),
  ]
  for (const cacheKey of keys) {
    const raw = sessionStorage.getItem(cacheKey)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as DashboardCachePayload
      if (parsed.cachedDay && parsed.cachedDay !== formatLocalCalendarDay() && parsed.stats) {
        parsed.stats.tradesTaken = 0
        parsed.stats.tradesTakenYesterday = 0
        parsed.stats.tradesWon = 0
        parsed.stats.tradesLost = 0
        parsed.stats.tradesBreakeven = 0
        parsed.stats.todayProfit = 0
        parsed.stats.yesterdayProfit = 0
        parsed.stats.tradesCopiedToday = 0
        parsed.stats.totalSignals = 0
        parsed.stats.totalVolume = 0
        parsed.stats.bestTradeProfit = 0
        parsed.stats.worstTradeProfit = 0
        parsed.stats.mostTradedAsset = '—'
      }
      return parsed
    } catch {
      continue
    }
  }
  return null
}

function seedLiveBrokerStateFromBalances(
  balances: Record<string, BrokerBalanceSnapshot> | undefined,
  target: Record<string, { open_pnl?: number; open_trades?: number }>,
  accounts?: BrokerAccount[],
) {
  if (!balances) return
  const connected = accounts
    ? new Set(accounts.filter(isBrokerLiveConnected).map(a => a.id))
    : null
  for (const [id, v] of Object.entries(balances)) {
    if (!v) continue
    if (connected && !connected.has(id)) continue
    target[id] = {
      open_pnl: typeof v.open_pnl === 'number' ? v.open_pnl : target[id]?.open_pnl,
      open_trades: typeof v.open_trades === 'number' ? v.open_trades : target[id]?.open_trades,
    }
  }
}

type DashboardCacheApplyHandlers = {
  setStats: (stats: DashboardStats) => void
  setCopierLogs: (logs: Signal[]) => void
  setCopierLogSymbols: (symbols: Record<string, string>) => void
  setChannelDisplayNames: (names: Record<string, string>) => void
  setLinkedAccountBalances: (balances: Record<string, BrokerBalanceSnapshot>) => void
  setChartTrades: (trades: DashboardChartTrade[]) => void
  setMtTrades: (trades: MtTrade[]) => void
  setAiExpertLogs: (logs: AiExpertLogRow[]) => void
  setChannelLinkMaps: (maps: PerformanceChannelLinkMaps) => void
  setCachedAnalytics: (analytics: DashboardAnalytics | null) => void
  setDashboardChartsReady: (ready: boolean) => void
  liveBrokerStateRef: MutableRefObject<Record<string, { open_pnl?: number; open_trades?: number }>>
  mtTradesRef: MutableRefObject<MtTrade[] | null>
  linkedBalancesRef: MutableRefObject<Record<string, BrokerBalanceSnapshot>>
}

function applyDashboardCacheSnapshot(
  userId: string,
  cached: DashboardCachePayload,
  handlers: DashboardCacheApplyHandlers,
  opts: { resetLiveRefs?: boolean } = {},
) {
  const { resetLiveRefs = false } = opts
  if (resetLiveRefs) {
    handlers.liveBrokerStateRef.current = {}
    handlers.mtTradesRef.current = null
    handlers.linkedBalancesRef.current = {}
  }

  handlers.setStats(statsFromDashboardCache(cached))
  handlers.setCopierLogs(cached.copierLogs ?? [])
  handlers.setCopierLogSymbols(cached.copierLogSymbols ?? {})
  handlers.setChannelDisplayNames(cached.channelDisplayNames ?? {})
  const balances = cached.linkedAccountBalances ?? {}
  handlers.linkedBalancesRef.current = balances
  handlers.setLinkedAccountBalances(balances)
  const chart = bootChartTrades(cached)
  if (chart.length) handlers.setChartTrades(chart)
  if (cached.aiExpertLogs?.length) handlers.setAiExpertLogs(cached.aiExpertLogs)
  if (cached.mtTrades?.length) {
    const scopedMtTrades = cached.linkedAccounts?.length
      ? filterMtTradesSinceConnect(cached.mtTrades, cached.linkedAccounts)
      : cached.mtTrades
    handlers.setMtTrades(scopedMtTrades)
    handlers.mtTradesRef.current = scopedMtTrades
  }
  if (cached.channelLinkMaps) handlers.setChannelLinkMaps(normalizeChannelLinkMaps(cached.channelLinkMaps))
  if (cached.cachedAnalytics) handlers.setCachedAnalytics(cached.cachedAnalytics)
  syncPerformanceCacheFromDashboard(userId)
  seedLiveBrokerStateFromBalances(balances, handlers.liveBrokerStateRef.current, cached.linkedAccounts)
  if (bootDashboardChartsReady(cached)) {
    handlers.setDashboardChartsReady(true)
  }
}

export function DashboardPage() {
  const t = useT()
  const la = t.dashboard.linkedAccounts
  const { user } = useAuth()
  const {
    brokers: linkedAccounts,
    loading: brokersLoading,
    setBrokers,
    patchBroker,
    replaceBroker,
    toggleBrokerActive: toggleBrokerActiveInStore,
    reconnectBroker: _reconnectBroker,
    brokersNeedingReconnect: _brokersNeedingReconnect,
    isReconnecting: isBrokerReconnecting,
    setReconnectErrorHandler,
    setReconnectSuccessHandler,
  } = useBrokerAccounts()
  const linkedAccountsRef = useRef(linkedAccounts)
  linkedAccountsRef.current = linkedAccounts
  const { openAddTradingAccount } = useAddTradingAccount()
  const { formatMoney, formatSignedMoney } = useFormatMoney()
  const navigate = useNavigate()
  const bootSnapshotRef = useRef<DashboardCachePayload | null>(null)
  if (bootSnapshotRef.current === null) {
    bootSnapshotRef.current = readBootstrapDashboardCache(user?.id)
  }
  const bootCache = bootSnapshotRef.current
  const hadBootCacheRef = useRef(Boolean(bootCache?.stats))
  /** True when this tab already loaded dashboard data earlier (SPA revisit, not hard refresh). */
  const tabSessionWarmRef = useRef(
    Boolean(user?.id && isDashboardSessionLoaded(user.id)),
  )
  const [stats, setStats] = useState<DashboardStats>(() => statsFromDashboardCache(bootCache))
  const [copierLogs, setCopierLogs] = useState<Signal[]>(() => bootCache?.copierLogs ?? [])
  const [copierLogSymbols, setCopierLogSymbols] = useState<Record<string, string>>(
    () => bootCache?.copierLogSymbols ?? {},
  )
  const [channelDisplayNames, setChannelDisplayNames] = useState<Record<string, string>>(
    () => bootCache?.channelDisplayNames ?? {},
  )
  const [aiExpertLogs, setAiExpertLogs] = useState<AiExpertLogRow[]>(() => bootCache?.aiExpertLogs ?? [])
  const [linkedAccountBalances, setLinkedAccountBalances] = useState<Record<string, BrokerBalanceSnapshot>>(
    () => bootCache?.linkedAccountBalances ?? {},
  )
  const [chartTrades, setChartTrades] = useState<DashboardChartTrade[]>(() => bootChartTrades(bootCache))
  const chartTradesRef = useRef(chartTrades)
  chartTradesRef.current = chartTrades
  const [mtTrades, setMtTrades] = useState<MtTrade[]>(() => bootCache?.mtTrades ?? [])
  const [channelLinkMaps, setChannelLinkMaps] = useState<PerformanceChannelLinkMaps>(
    () => normalizeChannelLinkMaps(bootCache?.channelLinkMaps),
  )
  const [cachedAnalytics, setCachedAnalytics] = useState<DashboardAnalytics | null>(
    () => bootCache?.cachedAnalytics ?? null,
  )
  const channelLinkMapsRef = useRef(channelLinkMaps)
  channelLinkMapsRef.current = channelLinkMaps
  const [togglingBrokerId, setTogglingBrokerId] = useState<string | null>(null)
  const [brokerReconnectError, setBrokerReconnectError] = useState('')
  const loadDashboardLiveRef = useRef<() => void>(() => {})
  const MT_TRADES_REFRESH_MS = 30_000
  const lastMtTradesRefreshRef = useRef<number>(0)
  /** Ignore stale responses when a newer *fresh* loadDashboard run started. */
  const loadGenerationRef = useRef(0)
  const dashboardMetricsDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dashboardReadyRef = useRef(Boolean(bootCache?.stats))
  const [dashboardMetricsLoading, setDashboardMetricsLoading] = useState(
    () => !(tabSessionWarmRef.current && isDashboardBootReady(bootCache)),
  )
  const [dashboardChartsReady, setDashboardChartsReady] = useState(() => bootDashboardChartsReady(bootCache))
  const linkedBalancesRef = useRef<Record<string, BrokerBalanceSnapshot>>(bootCache?.linkedAccountBalances ?? {})
  const refreshQuietRef = useRef<() => void>(() => {})
  /** Last successful MT trades response, kept across renders so stats survive throttled refresh windows. */
  const mtTradesRef = useRef<MtTrade[] | null>(bootCache?.mtTrades ?? null)
  useEffect(() => {
    mtTradesRef.current = mtTrades
  }, [mtTrades])
  /**
   * Last known MT live values per broker id, kept across `loadDashboard` calls so
   * throttled trade refreshes don't bounce stats back to DB defaults. Without this the
   * Active Trades stat can fluctuate between ticks.
   */
  const liveBrokerStateRef = useRef<Record<string, { open_pnl?: number; open_trades?: number }>>({})
  const positionBooksRef = useRef<Record<string, FxsocketPositionBook>>({})
  const wsMarkedConnectedRef = useRef(new Set<string>())
  const lastWsTickRef = useRef<Record<string, number>>({})
  const liveMetricsRafRef = useRef(0)
  if (bootCache?.linkedAccountBalances && Object.keys(liveBrokerStateRef.current).length === 0) {
    seedLiveBrokerStateFromBalances(
      bootCache.linkedAccountBalances,
      liveBrokerStateRef.current,
      bootCache.linkedAccounts,
    )
  }
  const statsRef = useRef(stats)
  useEffect(() => {
    statsRef.current = stats
  }, [stats])

  const scheduleDismissDashboardMetricsLoader = () => {
    if (dashboardMetricsDismissTimerRef.current) {
      clearTimeout(dashboardMetricsDismissTimerRef.current)
    }
    dashboardMetricsDismissTimerRef.current = window.setTimeout(() => {
      dashboardMetricsDismissTimerRef.current = null
      setDashboardMetricsLoading(false)
    }, DASHBOARD_METRICS_LOADER_DISMISS_MS)
  }

  const cancelDismissDashboardMetricsLoader = () => {
    if (dashboardMetricsDismissTimerRef.current) {
      clearTimeout(dashboardMetricsDismissTimerRef.current)
      dashboardMetricsDismissTimerRef.current = null
    }
  }

  const showDashboardMetricsLoader = () => {
    cancelDismissDashboardMetricsLoader()
    setDashboardMetricsLoading(true)
  }

  useLayoutEffect(() => {
    if (!user?.id) return

    const previousUser = getDashboardActiveUserId()
    const isUserSwitch = previousUser != null && previousUser !== user.id
    if (isUserSwitch) {
      clearDashboardSessionCache(previousUser)
      bootSnapshotRef.current = null
      hadBootCacheRef.current = false
    }
    setDashboardActiveUserId(user.id)

    const cached = readBootstrapDashboardCache(user.id)
    if (cached?.stats) {
      bootSnapshotRef.current = cached
      hadBootCacheRef.current = true
      applyDashboardCacheSnapshot(user.id, cached, {
        setStats,
        setCopierLogs,
        setCopierLogSymbols,
        setChannelDisplayNames,
        setLinkedAccountBalances,
        setChartTrades,
        setMtTrades,
        setAiExpertLogs,
        setChannelLinkMaps,
        setCachedAnalytics,
        setDashboardChartsReady,
        liveBrokerStateRef,
        mtTradesRef,
        linkedBalancesRef,
      }, { resetLiveRefs: isUserSwitch })
      markDashboardSessionLoaded(user.id)
      dashboardReadyRef.current = isDashboardBootReady(cached)
      if (tabSessionWarmRef.current && isDashboardBootReady(cached)) {
        cancelDismissDashboardMetricsLoader()
        setDashboardMetricsLoading(false)
      } else if (!isDashboardBootReady(cached)) {
        showDashboardMetricsLoader()
      }
      return
    }

    if (isUserSwitch || !isDashboardSessionLoaded(user.id)) {
      liveBrokerStateRef.current = {}
      mtTradesRef.current = null
      linkedBalancesRef.current = {}
      setStats(DEFAULT_DASHBOARD_STATS)
      setCopierLogs([])
      setCopierLogSymbols({})
      setChannelDisplayNames({})
      setLinkedAccountBalances({})
      setChartTrades([])
      setMtTrades([])
      setAiExpertLogs([])
      setChannelLinkMaps(EMPTY_CHANNEL_LINK_MAPS)
      setCachedAnalytics(null)
      setDashboardChartsReady(false)
      showDashboardMetricsLoader()
      hadBootCacheRef.current = false
    }
    dashboardReadyRef.current = false
    return () => {
      cancelDismissDashboardMetricsLoader()
    }
  }, [user?.id])

  /** Keep last chart snapshot visible while a refresh briefly returns empty data. */
  const effectiveChartTrades = useMemo(() => {
    if (chartTrades.length > 0) return chartTrades
    const sticky = chartTradesRef.current
    return sticky.length > 0 ? sticky : chartTrades
  }, [chartTrades])

  const dashboardAnalytics = useMemo(
    () => deriveDashboardAnalytics({
      chartTrades: effectiveChartTrades,
      mtTrades,
      channelLinkMaps,
      unlinkedLabel: t.performance.unlinkedChannel,
      accounts: linkedAccounts,
    }),
    [effectiveChartTrades, mtTrades, channelLinkMaps, linkedAccounts, t.performance.unlinkedChannel],
  )

  const displayAnalytics = useMemo(() => {
    const live = dashboardAnalytics
    const hasLinkedBroker = linkedAccounts.some(isFxsocketLinkedBroker)
    if (hasDashboardAnalyticsData(live)) return live
    if (cachedAnalytics && hasDashboardAnalyticsData(cachedAnalytics) && !hasLinkedBroker) {
      return cachedAnalytics
    }
    if (!cachedAnalytics) return live
    return {
      ...live,
      todayProfit: live.todayProfit !== 0 ? live.todayProfit : cachedAnalytics.todayProfit,
      yesterdayProfit: live.yesterdayProfit !== 0 ? live.yesterdayProfit : cachedAnalytics.yesterdayProfit,
      tradeVolume7Day: hasLinkedBroker
        ? live.tradeVolume7Day
        : live.tradeVolume7Day.some(d => d.volume > 0 || d.profit !== 0 || d.loss !== 0)
          ? live.tradeVolume7Day
          : cachedAnalytics.tradeVolume7Day,
      channelProfit7d: hasLinkedBroker
        ? live.channelProfit7d
        : live.channelProfit7d.length > 0
          ? live.channelProfit7d
          : cachedAnalytics.channelProfit7d,
      tradesTaken: live.tradesTaken > 0 ? live.tradesTaken : cachedAnalytics.tradesTaken,
      tradesTakenYesterday: live.tradesTakenYesterday > 0
        ? live.tradesTakenYesterday
        : cachedAnalytics.tradesTakenYesterday,
      tradesWon: live.tradesWon > 0 ? live.tradesWon : cachedAnalytics.tradesWon,
      tradesLost: live.tradesLost > 0 ? live.tradesLost : cachedAnalytics.tradesLost,
      tradesBreakeven: live.tradesBreakeven > 0 ? live.tradesBreakeven : cachedAnalytics.tradesBreakeven,
    }
  }, [dashboardAnalytics, cachedAnalytics, linkedAccounts])

  /** Headline stats: prefer display analytics (live or cached) when available. */
  const headlineStats = useMemo(() => {
    const analytics = displayAnalytics
    const hasAnalytics = hasDashboardAnalyticsData(analytics)
    return {
      ...stats,
      todayProfit: hasAnalytics ? analytics.todayProfit : stats.todayProfit,
      yesterdayProfit: hasAnalytics ? analytics.yesterdayProfit : stats.yesterdayProfit,
      tradesTaken: hasAnalytics ? analytics.tradesTaken : stats.tradesTaken,
      tradesTakenYesterday: hasAnalytics ? analytics.tradesTakenYesterday : stats.tradesTakenYesterday,
      tradesWon: hasAnalytics ? analytics.tradesWon : stats.tradesWon,
      tradesLost: hasAnalytics ? analytics.tradesLost : stats.tradesLost,
      tradesBreakeven: hasAnalytics ? analytics.tradesBreakeven : stats.tradesBreakeven,
    }
  }, [stats, displayAnalytics])

  const connectPnlByAccountId = useMemo(
    () => computeConnectPnlByAccountId(linkedAccounts, linkedAccountBalances, mtTrades),
    [linkedAccounts, linkedAccountBalances, mtTrades],
  )

  const openPnlAccountCount = useMemo(() => {
    let accountCount = countAccountsWithOpenPositions(
      linkedAccounts,
      linkedAccountBalances,
      mtTrades,
    )
    if (accountCount === 0 && stats.openTrades > 0) {
      const brokers = new Set(
        effectiveChartTrades.filter(t => t.status === 'open').map(t => t.brokerAccountId),
      )
      accountCount = brokers.size
    }
    return accountCount
  }, [linkedAccounts, linkedAccountBalances, effectiveChartTrades, stats.openTrades, mtTrades])

  const openPnlSub = useMemo(() => {
    if (openPnlAccountCount === 0) return t.dashboard.openPnlNoOpen
    if (openPnlAccountCount === 1) return t.dashboard.openPnlAcrossOneAccount
    return interpolate(t.dashboard.openPnlAcrossAccounts, { count: String(openPnlAccountCount) })
  }, [openPnlAccountCount, t])

  const portfolioActiveSignalGroups = useMemo(
    () => buildPortfolioActiveSignalGroups({
      accounts: linkedAccounts,
      mtTrades,
      channelLinkMaps,
      balances: linkedAccountBalances,
      unnamedAccountLabel: la.unnamedAccount,
    }),
    [linkedAccounts, mtTrades, channelLinkMaps, linkedAccountBalances, la.unnamedAccount],
  )

  const [openPnlModalOpen, setOpenPnlModalOpen] = useState(false)

  const equityByAccountId = useMemo(() => {
    const out: Record<string, number> = {}
    for (const account of linkedAccounts) {
      const live = linkedAccountBalances[account.id]
      const eq = live?.equity ?? live?.balance ?? account.last_equity ?? account.last_balance
      if (eq != null && Number.isFinite(Number(eq))) {
        out[account.id] = Number(eq)
      }
    }
    return out
  }, [linkedAccounts, linkedAccountBalances])

  const visibleTradeActivities = useMemo(
    () => buildDisplayableTradeActivities(aiExpertLogs, t.channelWorker, t.management, channelDisplayNames),
    [aiExpertLogs, channelDisplayNames, t.channelWorker, t.management],
  )

  const [linkedAccountSortKey, setLinkedAccountSortKey] = useState<LinkedAccountSortKey | null>(null)
  const [linkedAccountSortDir, setLinkedAccountSortDir] = useState<SortDirection>('asc')

  const onLinkedAccountSort = (key: LinkedAccountSortKey) => {
    if (linkedAccountSortKey === key) {
      setLinkedAccountSortKey(null)
      setLinkedAccountSortDir('asc')
      return
    }
    setLinkedAccountSortKey(key)
    setLinkedAccountSortDir('asc')
  }

  const linkedAccountPerformance = useMemo(() => {
    const tradesByAccountId: Record<string, TradeStatsRow[]> = {}
    if (mtTrades.length > 0) {
      for (const t of mtTrades) {
        const row: TradeStatsRow = {
          status: t.status,
          profit: t.profit,
          closed_at: t.closed_at,
          opened_at: t.opened_at,
          symbol: t.symbol,
          lot_size: t.lot_size,
          direction: t.direction,
          type: t.type,
          swap: t.swap,
          commission: t.commission,
        }
        const list = tradesByAccountId[t.broker_id] ?? []
        list.push(row)
        tradesByAccountId[t.broker_id] = list
      }
    } else {
      for (const t of effectiveChartTrades) {
        if (t.status !== 'closed' || !t.closedAt) continue
        const row: TradeStatsRow = {
          status: 'closed',
          profit: t.profit,
          closed_at: t.closedAt,
          symbol: t.lotSize > 0 ? 'trade' : '',
          lot_size: t.lotSize,
          direction: t.lotSize > 0 ? 'buy' : '',
        }
        const list = tradesByAccountId[t.brokerAccountId] ?? []
        list.push(row)
        tradesByAccountId[t.brokerAccountId] = list
      }
    }
    return computeLinkedAccountPerformanceMap(linkedAccounts, tradesByAccountId, equityByAccountId)
  }, [linkedAccounts, effectiveChartTrades, equityByAccountId, mtTrades])

  const displayedLinkedAccounts = useMemo(() => {
    if (!linkedAccountSortKey) return linkedAccounts
    return sortLinkedAccounts(linkedAccounts, linkedAccountSortKey, linkedAccountSortDir, {
      balances: linkedAccountBalances,
      performance: linkedAccountPerformance,
      connectPnlByAccountId,
    })
  }, [
    linkedAccounts,
    linkedAccountSortKey,
    linkedAccountSortDir,
    linkedAccountBalances,
    linkedAccountPerformance,
    connectPnlByAccountId,
  ])

  const hasLinkedBroker = linkedAccounts.some(isFxsocketLinkedBroker)

  const formatVsYesterdayDelta = (
    todayValue: number,
    yesterdayValue: number,
    showWhenFlat = false,
  ) => {
    if (!Number.isFinite(todayValue) || !Number.isFinite(yesterdayValue)) return ''
    const delta = Math.round((todayValue - yesterdayValue) * 100) / 100
    if (delta === 0 && todayValue === 0 && yesterdayValue === 0 && !showWhenFlat) return ''
    return interpolate(t.common.vsYesterday, {
      amount: formatSignedMoney(delta === 0 && showWhenFlat ? 0 : delta),
    })
  }

  const loadDashboard = async (opts: { fresh?: boolean; syncLive?: boolean } = {}) => {
    const { fresh = false, syncLive = fresh } = opts
    const generation = fresh ? ++loadGenerationRef.current : loadGenerationRef.current
    try {
    const { todayStart, tomorrowStart, yesterdayStart } = getLocalCalendarDayBounds()
    const brokerAccountsEarly = linkedAccountsRef.current.length > 0
      ? linkedAccountsRef.current
      : [] as BrokerAccount[]
    const mtBrokerConnectedEarly = hasActiveMtBroker(brokerAccountsEarly)
    const mtTradesPromise = mtBrokerConnectedEarly
      ? fetchBrokerMtTrades({
          scope: 'dashboard',
          historyProfile: 'trades',
          limit: DASHBOARD_MT_HISTORY_LIMIT,
          accounts: brokerAccountsEarly,
          includeBalanceCashflow: false,
        }).catch(() => [] as MtTrade[])
      : Promise.resolve([] as MtTrade[])

    const [channelsRes, tradesRes, todaySignalsRes, yesterdaySignalsRes, logsRes, allSignalsRes, channelsMetaRes, attributionRes, aiLogsRes, prefetchedMtTrades] = await Promise.all([
      supabase.from('telegram_channels').select('id').eq('user_id', user!.id).eq('is_active', true),
      supabase
        .from('trades')
        .select('id,symbol,direction,profit,lot_size,status,opened_at,closed_at,broker_account_id,signal_id,metaapi_order_id,telegram_channel_id')
        .eq('user_id', user!.id)
        .order('opened_at', { ascending: false })
        .limit(3000),
      supabase.from('signals').select('status').eq('user_id', user!.id).gte('created_at', todayStart.toISOString()).lt('created_at', tomorrowStart.toISOString()),
      supabase.from('signals').select('status').eq('user_id', user!.id).gte('created_at', yesterdayStart.toISOString()).lt('created_at', todayStart.toISOString()),
      supabase
        .from('signals')
        .select('*')
        .eq('user_id', user!.id)
        .or('skip_reason.is.null,skip_reason.neq.non_trade_message')
        .order('created_at', { ascending: false })
        .limit(10),
      supabase.from('signals').select('id,channel_id').eq('user_id', user!.id),
      supabase.from('telegram_channels').select('id,display_name,channel_username').eq('user_id', user!.id),
      supabase
        .from('trade_channel_attributions')
        .select('broker_account_id,metaapi_order_id,signal_id,channel_id,channel_label')
        .eq('user_id', user!.id),
      supabase
        .from('trade_execution_logs')
        .select(
          `
          id,
          created_at,
          action,
          status,
          request_payload,
          response_payload,
          error_message,
          signal_id,
          signals ( channel_id, raw_message, parsed_data, status, skip_reason )
        `,
        )
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(20),
      mtTradesPromise,
    ])

    const logs = ((logsRes.data ?? []) as Signal[]).filter(s => !isNonTradeSkipReason(s.skip_reason))
    const symbolLookupPromise = buildSignalSymbolLookup(supabase, user!.id, logs)

    const allTrades = (tradesRes.data ?? []) as Trade[]
    const openTrades = allTrades.filter(t => t.status === 'open')
    const todaySignals = (todaySignalsRes.data ?? []) as { status: string }[]
    const copiedToday = todaySignals.filter(s => s.status === 'executed' || s.status === 'parsed').length
    const openPnlFromTrades = openTrades.reduce((sum, t) => sum + (t.profit ?? 0), 0)
    const isInRange = (dateString: string | null | undefined, start: Date, end: Date) =>
      isMtTimestampInRange(dateString, start, end)

    // Prefer live MT trades when we have a cached snapshot; otherwise use the
    // local `trades` table until the broker history refresh lands.
    const mtTrades = mtTradesRef.current
    const hasMtCache = Array.isArray(mtTrades) && mtTrades.length > 0
    const useMtTrades = hasMtCache
    type WindowedTrade = TradeStatsRow & {
      status: 'open' | 'closed'
      opened_at: string | null
    }
    const dbWindowed: WindowedTrade[] = allTrades.map(t => ({
      symbol: t.symbol ?? '',
      profit: typeof t.profit === 'number' ? t.profit : null,
      lot_size: t.lot_size ?? 0,
      status: t.status === 'closed' ? 'closed' : 'open',
      opened_at: t.opened_at ?? null,
      closed_at: t.closed_at ?? null,
    }))
    const mtWindowed: WindowedTrade[] = useMtTrades
      ? mtTrades!.map(t => ({
          symbol: t.symbol,
          profit: t.profit,
          lot_size: t.lot_size,
          status: t.status,
          opened_at: t.opened_at,
          closed_at: t.closed_at,
          direction: t.direction,
          type: t.type,
          swap: t.swap,
          commission: t.commission,
        }))
      : []
    const sourceTrades: WindowedTrade[] = useMtTrades ? mtWindowed : dbWindowed
    const closedTodayForStats = (closedAt: string | null) =>
      isMtTimestampInRange(closedAt, todayStart, tomorrowStart)
    const closedYesterdayForStats = (closedAt: string | null) =>
      isMtTimestampInRange(closedAt, yesterdayStart, todayStart)

    const tradesToday = sourceTrades.filter(t => isInRange(t.opened_at, todayStart, tomorrowStart))
    const tradesYesterday = sourceTrades.filter(t => isInRange(t.opened_at, yesterdayStart, todayStart))
    const totalVolume = tradesToday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0)
    const yesterdayTotalVolume = tradesYesterday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0)

    const closedTradeableToday = sourceTrades.filter(
      t => isTradeableClosedRow(t) && closedTodayForStats(t.closed_at),
    )
    const closedTradeableYesterday = sourceTrades.filter(
      t => isTradeableClosedRow(t) && closedYesterdayForStats(t.closed_at),
    )
    const legPnls = (rows: WindowedTrade[]) => rows.map(t => netClosedLegProfit(t))
    const posToday = legPnls(closedTradeableToday).filter(p => p > 0)
    const negToday = legPnls(closedTradeableToday).filter(p => p < 0)
    const posYest = legPnls(closedTradeableYesterday).filter(p => p > 0)
    const negYest = legPnls(closedTradeableYesterday).filter(p => p < 0)
    const bestTradeProfit = posToday.length ? Math.max(...posToday) : 0
    const yesterdayBestTradeProfit = posYest.length ? Math.max(...posYest) : 0
    const worstTradeProfit = negToday.length ? Math.min(...negToday) : 0
    const yesterdayWorstTradeProfit = negYest.length ? Math.min(...negYest) : 0

    const mostTradedAsset = (() => {
      const counts = new Map<string, number>()
      for (const trade of tradesToday) {
        if (!trade.symbol) continue
        counts.set(trade.symbol, (counts.get(trade.symbol) ?? 0) + 1)
      }
      let winner = '—'
      let max = 0
      for (const [symbol, count] of counts.entries()) {
        if (count > max) {
          winner = symbol
          max = count
        }
      }
      return winner
    })()
    const yesterdayMostTradedAsset = (() => {
      const counts = new Map<string, number>()
      for (const trade of tradesYesterday) {
        if (!trade.symbol) continue
        counts.set(trade.symbol, (counts.get(trade.symbol) ?? 0) + 1)
      }
      let winner = '—'
      let max = 0
      for (const [symbol, count] of counts.entries()) {
        if (count > max) {
          winner = symbol
          max = count
        }
      }
      return winner
    })()
    // Channel correlation requires our DB `trades` (which carries `signal_id`).
    // MT-sourced trades have no signal linkage, so we keep using the DB rows
    // for this single metric even when MT is the primary source above.
    const dbTradesToday = allTrades.filter(t => isInRange(t.opened_at, todayStart, tomorrowStart))
    const dbTradesYesterday = allTrades.filter(t => isInRange(t.opened_at, yesterdayStart, todayStart))
    const mostProfitableChannel = (() => {
      const signals = (allSignalsRes.data ?? []) as Array<{ id: string; channel_id: string | null }>
      const channels = (channelsMetaRes.data ?? []) as Array<{ id: string; display_name: string }>
      const signalToChannel = new Map<string, string | null>()
      for (const s of signals) signalToChannel.set(s.id, s.channel_id)
      const channelNameById = new Map<string, string>()
      for (const c of channels) channelNameById.set(c.id, c.display_name || 'Unnamed channel')
      const pnlByChannel = new Map<string, number>()
      for (const trade of dbTradesToday) {
        if (!trade.signal_id) continue
        const channelId = signalToChannel.get(trade.signal_id)
        if (!channelId) continue
        pnlByChannel.set(channelId, (pnlByChannel.get(channelId) ?? 0) + (trade.profit ?? 0))
      }
      let winnerName = '—'
      let winnerPnl = Number.NEGATIVE_INFINITY
      for (const [channelId, pnl] of pnlByChannel.entries()) {
        if (pnl > winnerPnl) {
          winnerPnl = pnl
          winnerName = channelNameById.get(channelId) ?? 'Unknown channel'
        }
      }
      return winnerName
    })()
    const yesterdayMostProfitableChannel = (() => {
      const signals = (allSignalsRes.data ?? []) as Array<{ id: string; channel_id: string | null }>
      const channels = (channelsMetaRes.data ?? []) as Array<{ id: string; display_name: string }>
      const signalToChannel = new Map<string, string | null>()
      for (const s of signals) signalToChannel.set(s.id, s.channel_id)
      const channelNameById = new Map<string, string>()
      for (const c of channels) channelNameById.set(c.id, c.display_name || 'Unnamed channel')
      const pnlByChannel = new Map<string, number>()
      for (const trade of dbTradesYesterday) {
        if (!trade.signal_id) continue
        const channelId = signalToChannel.get(trade.signal_id)
        if (!channelId) continue
        pnlByChannel.set(channelId, (pnlByChannel.get(channelId) ?? 0) + (trade.profit ?? 0))
      }
      let winnerName = '—'
      let winnerPnl = Number.NEGATIVE_INFINITY
      for (const [channelId, pnl] of pnlByChannel.entries()) {
        if (pnl > winnerPnl) {
          winnerPnl = pnl
          winnerName = channelNameById.get(channelId) ?? 'Unknown channel'
        }
      }
      return winnerName
    })()
    const brokerAccounts = linkedAccountsRef.current.length > 0
      ? linkedAccountsRef.current
      : [] as BrokerAccount[]
    const channelMaps = buildPerformanceChannelLinkMaps(
      (channelsMetaRes.data ?? []) as Array<{
        id: string
        display_name: string
        channel_username?: string | null
      }>,
      allTrades
        .filter(t => t.metaapi_order_id && t.broker_account_id)
        .map(t => ({
          broker_account_id: t.broker_account_id,
          metaapi_order_id: t.metaapi_order_id,
          signal_id: t.signal_id,
          telegram_channel_id: t.telegram_channel_id,
        })),
      (allSignalsRes.data ?? []) as Array<{ id: string; channel_id: string | null }>,
      (attributionRes.data ?? []) as Array<{
        broker_account_id: string | null
        metaapi_order_id: string | null
        signal_id: string | null
        channel_id: string | null
        channel_label: string | null
      }>,
    )
    const mtBrokerConnected = hasActiveMtBroker(brokerAccounts)
    const activeBrokerCount = countLinkedBrokerSessions(brokerAccounts)
    // Seed the balance map from the cached columns the worker / edge function
    // wrote on AccountSummary. This is what makes the page render instantly
    // without waiting for a live FxSocket roundtrip on every page load.
    const balanceMap = Object.fromEntries(
      brokerAccounts.map((account) => {
        // Best-effort Open PnL on first paint: equity = total balance + floating P/L.
        const totalBalance = resolveBrokerTotalBalance(account)
        const cachedOpenPnl =
          account.last_equity != null && totalBalance != null
            ? account.last_equity - totalBalance
            : undefined
        // Re-apply the last MT live values we've already fetched this session so
        // the stat doesn't bounce between throttled refresh windows.
        const sticky = liveBrokerStateRef.current[account.id]
        const liveOk = isBrokerLiveForMetrics(account, wsMarkedConnectedRef.current)
        return [
          account.id,
          {
            balance: totalBalance ?? undefined,
            equity: account.last_equity ?? undefined,
            currency: account.last_currency ?? undefined,
            broker: account.broker_name ?? undefined,
            mt_server_hint: account.broker_server ?? undefined,
            account_type: resolveLinkedAccountTypeForBroker(account),
            open_pnl: liveOk ? (sticky?.open_pnl ?? cachedOpenPnl) : 0,
            open_trades: liveOk ? sticky?.open_trades : 0,
          },
        ]
      }),
    ) as Record<string, BrokerBalanceSnapshot>
    const mergedBalances = mergeBrokerBalances(
      balanceMap,
      linkedBalancesRef.current,
      liveBrokerStateRef.current,
      brokerAccounts,
      wsMarkedConnectedRef.current,
    )
    const chartTradesForLoad = resolveAnalyticsChartTrades(
      useMtTrades ? mtTradesRef.current : null,
      allTrades,
      mtBrokerConnected,
    )
    const analyticsForLoad = deriveDashboardAnalytics({
      chartTrades: chartTradesForLoad,
      mtTrades: useMtTrades ? (mtTradesRef.current ?? []) : [],
      channelLinkMaps: channelMaps,
      unlinkedLabel: t.performance.unlinkedChannel,
      accounts: brokerAccounts,
    })
    const todayProfit = analyticsForLoad.todayProfit
    const yesterdayProfit = analyticsForLoad.yesterdayProfit
    /** Lifetime realized P/L from closed MT deals (not balance/equity deltas). */
    const yesterdayTotalProfitLoss: number | null = null
    const totalProfitLoss = aggregateTotalProfitFromMtTrades(
      brokerAccounts,
      useMtTrades && mtTrades ? mtTrades : null,
    )
    const totalPortfolioValue = brokerAccounts.reduce((sum, account) => {
      const acct = mergedBalances[account.id]
      return sum + (acct?.balance ?? 0)
    }, 0)
    const totalEquityValue = brokerAccounts.reduce((sum, account) => {
      const acct = mergedBalances[account.id]
      return sum + (acct?.equity ?? acct?.balance ?? 0)
    }, 0)
    const totalLiveOpenPnl = brokerAccounts.reduce((sum, account) => {
      if (!isBrokerLiveForMetrics(account, wsMarkedConnectedRef.current)) return sum
      const acct = mergedBalances[account.id]
      return sum + (acct?.open_pnl ?? 0)
    }, 0)
    const hasAnyBrokerOpenPnl = brokerAccounts.some(
      account =>
        isBrokerLiveForMetrics(account, wsMarkedConnectedRef.current)
        && mergedBalances[account.id]?.open_pnl != null,
    )
    const hasAnyBrokerOpenTradesFromSummary = hasConnectedBrokerOpenTrades(brokerAccounts, mergedBalances)
    const resolvedOpenTradesCount = resolveDashboardOpenTradesCount(
      brokerAccounts,
      mergedBalances,
      openTrades.length,
    )
    const channelNames = buildChannelDisplayNames((channelsMetaRes.data ?? []) as ChannelNameRow[])
    setChannelLinkMaps(channelMaps)
    const nextStats: DashboardStats = {
      accounts: activeBrokerCount,
      portfolioValue: totalPortfolioValue,
      totalEquity: totalEquityValue,
      tradesTaken: analyticsForLoad.tradesTaken,
      tradesTakenYesterday: analyticsForLoad.tradesTakenYesterday,
      tradesWon: analyticsForLoad.tradesWon,
      tradesLost: analyticsForLoad.tradesLost,
      tradesBreakeven: analyticsForLoad.tradesBreakeven,
      openPnl: hasAnyBrokerOpenPnl ? totalLiveOpenPnl : openPnlFromTrades,
      openPositions: resolvedOpenTradesCount,
      openTrades: resolvedOpenTradesCount,
      tradesCopiedToday: copiedToday,
      activeChannels: channelsRes.data?.length ?? 0,
      copierHealth: activeBrokerCount > 0 ? 'Stable' : 'Offline',
      totalSignals: (todaySignalsRes.data ?? []).length,
      yesterdayTotalSignals: (yesterdaySignalsRes.data ?? []).length,
      totalVolume,
      yesterdayTotalVolume,
      totalProfitLoss,
      yesterdayTotalProfitLoss,
      bestTradeProfit,
      yesterdayBestTradeProfit,
      worstTradeProfit,
      yesterdayWorstTradeProfit,
      todayProfit,
      yesterdayProfit,
      mostProfitableChannel,
      yesterdayMostProfitableChannel,
      mostTradedAsset,
      yesterdayMostTradedAsset,
    }
    const stickyOpenPnl = brokerAccounts.reduce((sum, account) => {
      const p = liveBrokerStateRef.current[account.id]?.open_pnl
      return sum + (p != null && Number.isFinite(p) ? p : 0)
    }, 0)
    if (
      brokerAccounts.some(
        account => liveBrokerStateRef.current[account.id]?.open_pnl != null,
      )
    ) {
      nextStats.openPnl = stickyOpenPnl
    }
    if (fresh && generation !== loadGenerationRef.current) return

    const aiLogs = dedupePipelineParseAttempts((aiLogsRes.data ?? []) as AiExpertLogRow[])
    const chartFromDb = resolveAnalyticsChartTrades(
      hasMtCache ? mtTradesRef.current : null,
      allTrades,
      mtBrokerConnected,
    )

    const mergedAfterDb = mergeDashboardStats(statsRef.current, nextStats, useMtTrades, {
      trustOpenTrades: brokerAccounts.some(isFxsocketLinkedBroker) || hasAnyBrokerOpenTradesFromSummary,
      preserveMtTradeCounts: mtBrokerConnected && useMtTrades,
      preserveMtPnl: mtBrokerConnected && useMtTrades,
      mtHasClosedTrades: useMtTrades
        ? sourceTrades.some(t => t.status === 'closed')
        : undefined,
    })
    statsRef.current = mergedAfterDb
    setStats(mergedAfterDb)
    setChannelDisplayNames(channelNames)
    const sortedBrokerAccounts = sortBrokerAccountsNewestFirst(brokerAccounts)
    setBrokers(sortedBrokerAccounts)
    linkedBalancesRef.current = mergedBalances
    setLinkedAccountBalances(mergedBalances)
    setAiExpertLogs(aiLogs)

    if (mtBrokerConnected && (syncLive || fresh)) {
      await refreshMtTrades(brokerAccounts, { force: true, preloadedTrades: prefetchedMtTrades })
      if (fresh && generation !== loadGenerationRef.current) return
    }

    const chartForState = resolveAnalyticsChartTrades(mtTradesRef.current, allTrades, mtBrokerConnected)
    const chartToApply = chartForState.length > 0 ? chartForState : chartFromDb
    setChartTrades(prev => applyAuthoritativeChartTrades(prev, chartToApply, mtBrokerConnected))

    const analytics = computeDashboardAnalyticsSnapshot(
      chartToApply,
      mtTradesRef.current ?? [],
      channelMaps,
      t.performance.unlinkedChannel,
      sortedBrokerAccounts,
    )
    setCachedAnalytics(analytics)

    const logSymbols = buildCopierLogSymbolLabels(logs, await symbolLookupPromise)
    setCopierLogs(logs)
    setCopierLogSymbols(logSymbols)

    if (user) {
      writeDashboardCache(user.id, {
        stats: statsRef.current,
        copierLogs: logs,
        copierLogSymbols: logSymbols,
        channelDisplayNames: channelNames,
        linkedAccounts: sortedBrokerAccounts,
        linkedAccountBalances: linkedBalancesRef.current,
        chartTrades: chartToApply,
        aiExpertLogs: aiLogs,
        mtTrades: mtTradesRef.current ?? undefined,
        channelLinkMaps: channelMaps,
        cachedAnalytics: analytics,
      })
    }

    if (fresh && generation !== loadGenerationRef.current) return
    } finally {
      if (!fresh || generation === loadGenerationRef.current) {
        dashboardReadyRef.current = true
        setDashboardChartsReady(true)
      }
    }
  }

  refreshQuietRef.current = () => {
    if (!dashboardReadyRef.current || !user?.id) return
    void loadDashboard({ fresh: false, syncLive: false })
  }

  loadDashboardLiveRef.current = () => {
    if (!dashboardReadyRef.current) return
    void loadDashboard({ fresh: false, syncLive: true })
  }

  const bl = t.accountConfig.brokerList
  const connectErrorLabels = useMemo(() => brokerConnectErrorLabelsFromI18n(bl), [bl])
  const reconnectBannerText = useMemo(
    () => brokerReconnectBannerText(_brokersNeedingReconnect, {
      ...connectErrorLabels,
      droppedOne: bl.reconnectDroppedOne,
      droppedMany: bl.reconnectDroppedMany,
    }),
    [_brokersNeedingReconnect, connectErrorLabels, bl.reconnectDroppedOne, bl.reconnectDroppedMany],
  )

  useEffect(() => {
    setReconnectErrorHandler(message => setBrokerReconnectError(message))
    setReconnectSuccessHandler(() => loadDashboardLiveRef.current())
    return () => {
      setReconnectErrorHandler(null)
      setReconnectSuccessHandler(null)
    }
  }, [setReconnectErrorHandler, setReconnectSuccessHandler])

  const flushLiveBrokerMetrics = () => {
    if (liveMetricsRafRef.current) return
    liveMetricsRafRef.current = requestAnimationFrame(() => {
      liveMetricsRafRef.current = 0
      const balances = linkedBalancesRef.current
      const wsLive = wsMarkedConnectedRef.current
      setLinkedAccountBalances({ ...balances })
      setStats(prev => {
        const next = {
          ...prev,
          ...recomputeLiveBrokerDashboardStats(
            linkedAccountsRef.current,
            balances,
            prev,
            wsLive,
          ),
        }
        statsRef.current = next
        return next
      })
    })
  }

  const applyBrokerLiveSnapshot = (brokerId: string, patch: Partial<BrokerBalanceSnapshot>) => {
    linkedBalancesRef.current = {
      ...linkedBalancesRef.current,
      [brokerId]: {
        ...(linkedBalancesRef.current[brokerId] ?? {}),
        ...patch,
      },
    }
    liveBrokerStateRef.current[brokerId] = {
      ...liveBrokerStateRef.current[brokerId],
      ...(patch.open_trades != null ? { open_trades: patch.open_trades } : {}),
      ...(patch.open_pnl != null ? { open_pnl: patch.open_pnl } : {}),
    }
    flushLiveBrokerMetrics()
  }

  const markWsTick = (brokerId: string) => {
    lastWsTickRef.current[brokerId] = Date.now()
  }

  useFxsocketStream(linkedAccounts, {
    onAccount: (brokerId, snap) => {
      markWsTick(brokerId)
      const wasWsLive = wsMarkedConnectedRef.current.has(brokerId)
      wsMarkedConnectedRef.current.add(brokerId)
      if (
        !wasWsLive
        || !linkedAccountsRef.current.some(a => a.id === brokerId && isBrokerLiveConnected(a))
      ) {
        patchBroker(brokerId, {
          fxsocket_status: 'connected',
          connection_status: 'connected',
        })
      }
      const openTrades = linkedBalancesRef.current[brokerId]?.open_trades ?? 0
      const openPnlToApply = resolveFxsocketFloatingOpenPnl(snap, openTrades)
      const snapForBalances = openPnlToApply != null
        ? { ...snap, openPnl: openPnlToApply }
        : { ...snap, openPnl: undefined }
      const nextBalances = applyFxsocketAccountStreamUpdate(
        brokerId,
        snapForBalances,
        linkedBalancesRef.current,
      )
      linkedBalancesRef.current = nextBalances
      if (openPnlToApply != null) {
        liveBrokerStateRef.current[brokerId] = {
          ...liveBrokerStateRef.current[brokerId],
          open_pnl: openPnlToApply,
        }
      }
      flushLiveBrokerMetrics()
    },
    onPositions: (brokerId, snapshot, rawData) => {
      markWsTick(brokerId)
      wsMarkedConnectedRef.current.add(brokerId)
      const rows = unwrapFxsocketPositionsPayload(rawData)
      if (rows.length === 0) {
        positionBooksRef.current[brokerId] = new Map()
      } else if (rows.length === 1 && isFxsocketMarketPositionRow(rows[0])) {
        const book = positionBooksRef.current[brokerId] ?? new Map()
        mergePositionRowIntoBook(book, rows[0])
        positionBooksRef.current[brokerId] = book
      } else {
        positionBooksRef.current[brokerId] = rebuildPositionBookFromPayload(rawData)
      }
      const bookSnap = snapshotFromPositionBook(positionBooksRef.current[brokerId]!)
      const openPnl =
        bookSnap.openPnl ??
        snapshot.openPnl ??
        (snapshot.openTrades > 0 ? sumOpenPnlByBroker(mtTradesRef.current ?? [])[brokerId] : undefined)
      applyBrokerLiveSnapshot(brokerId, {
        open_trades: bookSnap.openTrades || snapshot.openTrades,
        ...(openPnl != null ? { open_pnl: openPnl } : {}),
      })
    },
    onTrade: (brokerId, data) => {
      markWsTick(brokerId)
      wsMarkedConnectedRef.current.add(brokerId)
      const book = positionBooksRef.current[brokerId] ?? new Map()
      mergePositionRowIntoBook(book, data)
      positionBooksRef.current[brokerId] = book
      const snap = snapshotFromPositionBook(book)
      applyBrokerLiveSnapshot(brokerId, {
        open_trades: snap.openTrades,
        open_pnl: snap.openPnl,
      })
    },
  }, linkedAccounts.some(isFxsocketLinkedBroker))

  /** REST fallback when WS is quiet — keeps Open P/L moving without a full page refresh. */
  useEffect(() => {
    const accounts = linkedAccounts.filter(isFxsocketLinkedBroker)
    if (accounts.length === 0) return

    let cancelled = false
    const pollLiveSnapshots = async () => {
      const now = Date.now()
      for (const account of accounts) {
        if (cancelled) return
        const lastWs = lastWsTickRef.current[account.id] ?? 0
        if (now - lastWs < 2500) continue
        try {
          const { summary } = await fxsocketBroker.liveSnapshot(account.id)
          if (cancelled) return
          const snap = parseFxsocketAccountStreamData(summary as Record<string, unknown>)
          const openTrades = linkedBalancesRef.current[account.id]?.open_trades ?? 0
          const openPnl = resolveFxsocketFloatingOpenPnl(snap, openTrades)
          const nextBalances = applyFxsocketAccountStreamUpdate(
            account.id,
            openPnl != null ? { ...snap, openPnl } : snap,
            linkedBalancesRef.current,
          )
          linkedBalancesRef.current = nextBalances
          if (openPnl != null) {
            liveBrokerStateRef.current[account.id] = {
              ...liveBrokerStateRef.current[account.id],
              open_pnl: openPnl,
            }
          }
          flushLiveBrokerMetrics()
        } catch {
          /* WS or next poll will retry */
        }
      }
    }

    const intervalId = window.setInterval(() => {
      void pollLiveSnapshots()
    }, 2000)
    void pollLiveSnapshots()

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [linkedAccounts.map(a => a.id).sort().join(',')])

  useDashboardRealtime(user?.id, () => refreshQuietRef.current(), broker => {
    replaceBroker(broker)
  })

  useEffect(() => {
    if (!user || brokersLoading) return

    const cached = readBootstrapDashboardCache(user.id)
    if (isDashboardBootReady(cached)) {
      dashboardReadyRef.current = true
      setDashboardChartsReady(true)
      if (tabSessionWarmRef.current) {
        cancelDismissDashboardMetricsLoader()
        setDashboardMetricsLoading(false)
      } else {
        scheduleDismissDashboardMetricsLoader()
      }
      if (cached?.linkedAccounts?.some(isFxsocketLinkedBroker)) {
        void loadDashboard({ fresh: false, syncLive: true })
      }
      return
    }

    let cancelled = false
    void (async () => {
      showDashboardMetricsLoader()
      try {
        await loadDashboard({ fresh: true, syncLive: true })
      } finally {
        if (!cancelled) {
          scheduleDismissDashboardMetricsLoader()
        }
      }
    })()

    return () => {
      cancelled = true
      cancelDismissDashboardMetricsLoader()
    }
  }, [user, brokersLoading])

  /**
   * Pull live trades (open + recent closed) from FxSocket for every linked
   * broker and recompute the performance stats from them. Throttled to one call
   * per MT_TRADES_REFRESH_MS so the 15s auto-tick doesn't hammer the edge fn.
   */
  const refreshMtTrades = async (
    brokerAccounts?: BrokerAccount[],
    opts?: { force?: boolean; preloadedTrades?: MtTrade[] },
  ) => {
    const now = Date.now()
    if (!opts?.force && now - lastMtTradesRefreshRef.current < MT_TRADES_REFRESH_MS) return
    const sourceAccounts = brokerAccounts ?? linkedAccounts
    const hasMtBroker = sourceAccounts.some(isFxsocketLinkedBroker)
    if (!hasMtBroker) return
    lastMtTradesRefreshRef.current = now

    let trades: MtTrade[]
    if (opts?.preloadedTrades !== undefined) {
      trades = opts.preloadedTrades
    } else {
      try {
        trades = await fetchBrokerMtTrades({
          scope: 'dashboard',
          historyProfile: 'trades',
          limit: DASHBOARD_MT_HISTORY_LIMIT,
          accounts: sourceAccounts,
          includeBalanceCashflow: false,
        })
      } catch {
        trades = mtTradesRef.current ?? []
        if (trades.length === 0) return
      }
    }

    const rawTrades = trades.length > 0 ? trades : (mtTradesRef.current ?? [])
    const resolvedTrades = filterMtTradesSinceConnect(rawTrades, sourceAccounts)
    if (trades.length > 0) {
      mtTradesRef.current = resolvedTrades
      setMtTrades(resolvedTrades)
    }
    if (resolvedTrades.length === 0) return

    const openByBroker = countOpenMarketPositionsByBroker(resolvedTrades)
    const openPnlByBroker = sumOpenPnlByBroker(resolvedTrades)
    const nextBalances = { ...linkedBalancesRef.current }
    let openCountsChanged = false
    for (const account of sourceAccounts) {
      if (!isFxsocketLinkedBroker(account)) continue
      const count = openByBroker[account.id] ?? 0
      const liveBook = positionBooksRef.current[account.id]
      if (!liveBook || liveBook.size === 0) {
        positionBooksRef.current[account.id] = rebuildPositionBookFromMtTrades(
          resolvedTrades,
          account.id,
        )
      }
      const bookSnap =
        (positionBooksRef.current[account.id]?.size ?? 0) > 0
          ? snapshotFromPositionBook(positionBooksRef.current[account.id]!)
          : null
      const openPnl = bookSnap?.openPnl ?? openPnlByBroker[account.id]
      const openTrades = bookSnap?.openTrades ?? count
      const prev = nextBalances[account.id]
      if (prev?.open_trades === openTrades && prev?.open_pnl === openPnl) continue
      nextBalances[account.id] = {
        ...(prev ?? {}),
        open_trades: openTrades,
        ...(openPnl != null ? { open_pnl: openPnl } : openTrades === 0 ? { open_pnl: 0 } : {}),
      }
      liveBrokerStateRef.current[account.id] = {
        ...liveBrokerStateRef.current[account.id],
        open_trades: openTrades,
        ...(openPnl != null ? { open_pnl: openPnl } : openTrades === 0 ? { open_pnl: 0 } : {}),
      }
      openCountsChanged = true
    }
    if (openCountsChanged) {
      linkedBalancesRef.current = nextBalances
      setLinkedAccountBalances(nextBalances)
      setStats(prev => {
        const next = {
          ...prev,
          ...recomputeLiveBrokerDashboardStats(
            linkedAccountsRef.current,
            nextBalances,
            prev,
            wsMarkedConnectedRef.current,
          ),
        }
        statsRef.current = next
        return next
      })
    }

    const chartNext = resolveAnalyticsChartTrades(resolvedTrades, [], true)
    setChartTrades(prev => applyAuthoritativeChartTrades(prev, chartNext, true))
    setDashboardChartsReady(true)

    const { todayStart: today0, tomorrowStart: tomorrow0, yesterdayStart: yesterday0 } =
      getLocalCalendarDayBounds()
    const inRange = (iso: string | null, start: Date, end: Date) =>
      isMtTimestampInRange(iso, start, end)

    const today = resolvedTrades.filter(t => inRange(t.opened_at, today0, tomorrow0))
    const yesterday = resolvedTrades.filter(t => inRange(t.opened_at, yesterday0, today0))
    const topSymbol = (rows: typeof trades): string => {
      const counts = new Map<string, number>()
      for (const r of rows) if (r.symbol) counts.set(r.symbol, (counts.get(r.symbol) ?? 0) + 1)
      let best = '—'
      let max = 0
      for (const [s, c] of counts.entries()) if (c > max) { best = s; max = c }
      return best
    }

    const closedTodayForStats = (closedAt: string | null) => inRange(closedAt, today0, tomorrow0)
    const closedYesterdayForStats = (closedAt: string | null) => inRange(closedAt, yesterday0, today0)
    const tradeRows: TradeStatsRow[] = resolvedTrades.filter(t => t.status === 'closed').map(t => ({
      status: t.status ?? 'closed',
      profit: t.profit,
      closed_at: t.closed_at,
      opened_at: t.opened_at,
      symbol: t.symbol,
      lot_size: t.lot_size,
      direction: t.direction,
      type: t.type,
      swap: t.swap,
      commission: t.commission,
    }))
    const closedTradeableToday = tradeRows.filter(
      t => isTradeableClosedRow(t) && closedTodayForStats(t.closed_at),
    )
    const closedTradeableYesterday = tradeRows.filter(
      t => isTradeableClosedRow(t) && closedYesterdayForStats(t.closed_at),
    )
    const legPnls = (rows: TradeStatsRow[]) => rows.map(t => netClosedLegProfit(t))
    const posTodayLeg = legPnls(closedTradeableToday).filter(p => p > 0)
    const negTodayLeg = legPnls(closedTradeableToday).filter(p => p < 0)
    const posYestLeg = legPnls(closedTradeableYesterday).filter(p => p > 0)
    const negYestLeg = legPnls(closedTradeableYesterday).filter(p => p < 0)
    const analyticsPatch = deriveDashboardAnalytics({
      chartTrades: chartNext,
      mtTrades: resolvedTrades,
      channelLinkMaps: channelLinkMapsRef.current,
      unlinkedLabel: t.performance.unlinkedChannel,
      accounts: linkedAccountsRef.current,
    })
    const mtStatsPatch: DashboardStats = {
      ...statsRef.current,
      tradesTaken: analyticsPatch.tradesTaken,
      tradesTakenYesterday: analyticsPatch.tradesTakenYesterday,
      tradesWon: analyticsPatch.tradesWon,
      tradesLost: analyticsPatch.tradesLost,
      tradesBreakeven: analyticsPatch.tradesBreakeven,
      todayProfit: analyticsPatch.todayProfit,
      yesterdayProfit: analyticsPatch.yesterdayProfit,
      totalVolume: today.reduce((sum, t) => sum + (t.lot_size ?? 0), 0),
      yesterdayTotalVolume: yesterday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0),
      bestTradeProfit: posTodayLeg.length ? Math.max(...posTodayLeg) : 0,
      yesterdayBestTradeProfit: posYestLeg.length ? Math.max(...posYestLeg) : 0,
      worstTradeProfit: negTodayLeg.length ? Math.min(...negTodayLeg) : 0,
      yesterdayWorstTradeProfit: negYestLeg.length ? Math.min(...negYestLeg) : 0,
      mostTradedAsset: topSymbol(today),
      yesterdayMostTradedAsset: topSymbol(yesterday),
    }
    statsRef.current = mtStatsPatch
    setStats(mtStatsPatch)
    if (user) {
      const chartForCache = chartNext.length > 0 ? chartNext : chartTradesRef.current
      const analytics = computeDashboardAnalyticsSnapshot(
        chartForCache,
        resolvedTrades,
        channelLinkMapsRef.current,
        t.performance.unlinkedChannel,
        linkedAccounts,
      )
      setCachedAnalytics(analytics)
      writeDashboardCache(user.id, {
        stats: mtStatsPatch,
        copierLogs,
        copierLogSymbols,
        channelDisplayNames,
        linkedAccounts,
        linkedAccountBalances: linkedBalancesRef.current,
        chartTrades: chartForCache,
        aiExpertLogs,
        mtTrades: resolvedTrades,
        channelLinkMaps: channelLinkMapsRef.current,
        cachedAnalytics: analytics,
      })
      syncPerformanceCacheFromDashboard(user.id)
    }
  }

  const toggleBrokerActive = async (id: string, is_active: boolean) => {
    if (!user) return
    const snapshot = linkedAccounts
    const applyActiveStats = (accounts: BrokerAccount[]) => {
      const activeCount = countLinkedBrokerSessions(accounts)
      setStats(s => ({
        ...s,
        accounts: activeCount,
        copierHealth: activeCount > 0 ? (s.copierHealth === 'Offline' ? 'Stable' : s.copierHealth) : 'Offline',
      }))
    }
    applyActiveStats(snapshot.map(a => (a.id === id ? { ...a, is_active } : a)))
    setTogglingBrokerId(id)
    const { error: upErr } = await toggleBrokerActiveInStore(id, is_active)
    setTogglingBrokerId(null)
    if (upErr) applyActiveStats(snapshot)
  }

  const chartsEmpty = effectiveChartTrades.length === 0 && linkedAccounts.length === 0
  const chartsLoading =
    !hadBootCacheRef.current &&
    !dashboardChartsReady &&
    !hasDashboardAnalyticsData(displayAnalytics) &&
    effectiveChartTrades.length === 0 &&
    mtTrades.length === 0 &&
    (hasActiveMtBroker(linkedAccounts) || Boolean(bootCache?.linkedAccounts?.some(isFxsocketLinkedBroker)))

  const showDashboardLoader = dashboardMetricsLoading

  return (
    <PageShell maxWidth="xl" spacing="none" className="space-y-6">
      {showDashboardLoader ? (
        <DashboardMetricsLoader message={t.dashboard.loadingMetrics} />
      ) : (
        <>
      <PageHeader title={t.dashboard.title} />
      <SubscriptionBanner />
      <TelegramConnectBanner className="mb-6" />

      {/* Stats bar */}
      <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 mb-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-neutral-100 dark:divide-neutral-800">
          <StatBlock
            label={t.dashboard.totalBalance}
            value={formatMoney(stats.totalEquity)}
            sub={interpolate(t.dashboard.acrossAccounts, { count: stats.accounts })}
            subColor="text-neutral-400"
          />
          <StatBlock
            label={t.dashboard.todaysProfit}
            labelHint={t.dashboard.todaysProfitHint}
            value={formatSignedMoney(headlineStats.todayProfit)}
            sub={formatVsYesterdayDelta(
              headlineStats.todayProfit,
              headlineStats.yesterdayProfit,
              hasLinkedBroker,
            )}
            valueColor={pnlSignTextClass(headlineStats.todayProfit)}
            subColor={
              headlineStats.todayProfit - headlineStats.yesterdayProfit < 0
                ? lossTextClass
                : 'text-neutral-400'
            }
          />
          <StatBlock
            label={t.dashboard.tradesTakenToday}
            value={String(headlineStats.tradesTaken)}
            sub={
              headlineStats.tradesTaken === 0 ? (
                t.dashboard.noClosedTradesToday
              ) : (
                <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  <span className="text-teal-600 dark:text-teal-500">
                    {interpolate(t.common.won, { count: headlineStats.tradesWon })}
                  </span>
                  <span className="text-neutral-300 dark:text-neutral-600">•</span>
                  <span className={lossTextClass}>
                    {interpolate(t.common.lost, { count: headlineStats.tradesLost })}
                  </span>
                  {headlineStats.tradesBreakeven > 0 ? (
                    <>
                      <span className="text-neutral-300 dark:text-neutral-600">•</span>
                      <span className="text-neutral-500 dark:text-neutral-400">
                        {interpolate(t.common.breakeven, { count: headlineStats.tradesBreakeven })}
                      </span>
                    </>
                  ) : null}
                </span>
              )
            }
            subColor="text-neutral-400"
          />
          <StatBlock
            label={t.dashboard.openPnl}
            value={formatSignedMoney(stats.openPnl)}
            sub={
              openPnlAccountCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setOpenPnlModalOpen(true)}
                  className="text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300 underline-offset-2 hover:underline font-medium"
                >
                  {openPnlSub}
                </button>
              ) : (
                openPnlSub
              )
            }
            valueColor={pnlSignTextClass(stats.openPnl)}
            subColor="text-neutral-500"
          />
        </div>
        <div className="border-t border-neutral-100 dark:border-neutral-800 p-4 sm:p-5 grid grid-cols-2 lg:grid-cols-4 gap-4">
          <OverviewStat
            label={t.dashboard.activeSignalChannels}
            value={String(stats.activeChannels)}
            // sub={t.dashboard.connectedTelegramChannels}
            addTo="/channels"
            addLabel={t.dashboard.manageChannels}
          />
          <OverviewStat
            label={t.dashboard.openTrades}
            value={String(stats.openTrades)}
            // sub={t.dashboard.activeBrokerPositions}
          />
          <OverviewStat
            label={t.dashboard.tradingAccountsConnected}
            value={String(stats.accounts)}
            // sub={interpolate(t.dashboard.acrossAccounts, { count: stats.accounts })}
            onAdd={openAddTradingAccount}
            addLabel={t.dashboard.addOrManageAccounts}
          />
          <OverviewStat
            label={t.dashboard.tradesCopiedToday}
            value={String(stats.tradesCopiedToday)}
            // sub={t.dashboard.executedFromSignals}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <TradeVolumeChart data={displayAnalytics.tradeVolume7Day} loading={chartsLoading} />
        <ChannelProfitChart
          data={displayAnalytics.channelProfit7d}
          loading={chartsLoading}
        />
      </div>

      {/* Lower panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* AI Expert Log */}
          <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 min-w-0">
          <div className="px-4 sm:px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-teal-500" />
              <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{t.dashboard.tradeActivities}</span>
              <InfoTooltip text={t.dashboard.tradeActivitiesHint} />
            </div>
            <button
              onClick={() => navigate('/activities')}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 dark:border-teal-600 text-teal-600 dark:text-teal-400 rounded-lg text-xs font-medium hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
            >
              {t.dashboard.management}
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          {visibleTradeActivities.length === 0 && chartsEmpty && aiExpertLogs.length === 0 ? (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="px-5 py-3">
                  <div className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-3/4 mb-1.5" />
                  <div className="h-3 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-1/3" />
                </div>
              ))}
            </div>
          ) : visibleTradeActivities.length === 0 ? (
            <div className="px-5 py-10 text-sm text-neutral-400">{t.dashboard.noTradeActivities}</div>
          ) : (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-96 overflow-y-auto">
              {visibleTradeActivities.map(activity => (
                <TradeActivityCard key={activity.row.id} activity={activity} variant="compact" />
              ))}
            </div>
          )}
        </div>

        {/* Copier Logs */}
        <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 min-w-0 overflow-hidden">
          <div className="px-4 sm:px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-teal-500" />
              <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{t.dashboard.copierLogs}</span>
              <InfoTooltip text={t.copierLogs.subtitle} />
            </div>
            <button
              onClick={() => navigate('/copier-logs')}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 dark:border-teal-600 text-teal-600 dark:text-teal-400 rounded-lg text-xs font-medium hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
            >
              {t.dashboard.copierLogs}
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          <div className="overflow-x-auto">
          {/* Table header */}
          <div
            className={`${DASHBOARD_COPIER_LOG_GRID} min-w-[28rem] px-4 sm:px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-medium text-neutral-400 uppercase tracking-wide`}
          >
            <span>{t.copierLogs.colStatus}</span>
            <span className="min-w-0">{t.copierLogs.colChannel}</span>
            <span>{t.copierLogs.colSymbol}</span>
            <span>{t.copierLogs.colType}</span>
            <span className="text-right">{t.copierLogs.colTime}</span>
          </div>

          {copierLogs.length === 0 && chartsEmpty ? (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(4)].map((_, i) => (
                <div key={i} className={`${DASHBOARD_COPIER_LOG_GRID} px-5 py-3`}>
                  {[...Array(5)].map((_, j) => (
                    <div key={j} className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse min-w-0" />
                  ))}
                </div>
              ))}
            </div>
          ) : copierLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-5">
              <div className="w-20 h-20 bg-neutral-100 dark:bg-neutral-800 rounded-2xl flex items-center justify-center mb-3 relative">
                <svg className="w-10 h-10 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <div className="absolute -top-1 -right-1 w-6 h-6 bg-neutral-200 rounded-full flex items-center justify-center">
                  <svg className="w-3 h-3 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-3 3-1-1" />
                  </svg>
                </div>
              </div>
              <p className="text-sm text-neutral-400 font-medium">{t.dashboard.noData}</p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-80 overflow-y-auto min-w-[28rem]">
              {copierLogs.map(log => (
                <LogRow
                  key={log.id}
                  signal={log}
                  channelName={channelLabel(log.channel_id, channelDisplayNames)}
                  symbol={copierLogSymbols[log.id] ?? '—'}
                />
              ))}
            </div>
          )}
          </div>
        </div>
      </div>

      {/* Linked Accounts */}
      <div className="mt-4 sm:mt-6 bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div>
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 inline-flex items-center gap-2">
                {la.title}
                <span className="inline-flex items-center justify-center min-w-[1.375rem] h-5 px-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs font-semibold text-neutral-500 dark:text-neutral-400 tabular-nums">
                  {linkedAccounts.length}
                </span>
              </p>
              <p className="text-xs text-neutral-400 dark:text-neutral-500">{la.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={openAddTradingAccount}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 dark:border-teal-600 text-teal-600 dark:text-teal-400 rounded-lg text-xs font-medium hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t.common.add}
          </button>
        </div>

        {brokerReconnectError ? (
          <div className="px-4 sm:px-5 py-2 text-sm text-neutral-600 dark:text-neutral-400 border-b border-neutral-100 dark:border-neutral-800">
            {brokerReconnectError}
          </div>
        ) : null}

        {_brokersNeedingReconnect.length > 0 ? (
          <div className="px-4 sm:px-5 py-2 text-sm text-amber-700 dark:text-amber-300 border-b border-neutral-100 dark:border-neutral-800">
            {reconnectBannerText}
          </div>
        ) : null}

        <div className="overflow-x-auto">
        <div className="min-w-[52rem] lg:min-w-0">
        <div className="hidden lg:grid grid-cols-9 gap-2 px-4 sm:px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-medium text-neutral-400">
          <LinkedAccountSortHeader
            label={la.colAccount}
            sortKey="account"
            activeKey={linkedAccountSortKey}
            direction={linkedAccountSortDir}
            onSort={onLinkedAccountSort}
          />
          <LinkedAccountSortHeader
            label={la.colBroker}
            sortKey="broker"
            activeKey={linkedAccountSortKey}
            direction={linkedAccountSortDir}
            onSort={onLinkedAccountSort}
          />
          <LinkedAccountSortHeader
            label={la.colAccountType}
            sortKey="accountType"
            activeKey={linkedAccountSortKey}
            direction={linkedAccountSortDir}
            onSort={onLinkedAccountSort}
          />
          <LinkedAccountSortHeader
            label={la.colBalance}
            sortKey="balance"
            activeKey={linkedAccountSortKey}
            direction={linkedAccountSortDir}
            onSort={onLinkedAccountSort}
          />
          <LinkedAccountSortHeader
            label={la.colPnl}
            sortKey="pnl"
            activeKey={linkedAccountSortKey}
            direction={linkedAccountSortDir}
            onSort={onLinkedAccountSort}
            title={la.colPnlHint}
          />
          <LinkedAccountSortHeader
            label={la.colOpenPnl}
            sortKey="openPnl"
            activeKey={linkedAccountSortKey}
            direction={linkedAccountSortDir}
            onSort={onLinkedAccountSort}
            title={la.colOpenPnlHint}
          />
          <LinkedAccountSortHeader
            label={la.colWinRate}
            sortKey="winRate"
            activeKey={linkedAccountSortKey}
            direction={linkedAccountSortDir}
            onSort={onLinkedAccountSort}
          />
          <LinkedAccountSortHeader
            label={la.colDd}
            sortKey="dd"
            activeKey={linkedAccountSortKey}
            direction={linkedAccountSortDir}
            onSort={onLinkedAccountSort}
          />
          <LinkedAccountSortHeader
            label={la.colStatus}
            sortKey="status"
            activeKey={linkedAccountSortKey}
            direction={linkedAccountSortDir}
            onSort={onLinkedAccountSort}
            align="right"
          />
        </div>

        {linkedAccounts.length === 0 && chartsEmpty ? (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="hidden lg:flex px-4 sm:px-5 py-3 gap-4">
                {[...Array(9)].map((_, j) => (
                  <div key={j} className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse flex-1" />
                ))}
              </div>
            ))}
          </div>
        ) : linkedAccounts.length === 0 ? (
          <div className="px-5 py-8 text-sm text-neutral-400">{la.empty}</div>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800"> 
            {displayedLinkedAccounts.map(account => (
              <LinkedAccountRow
                key={account.id}
                account={account}
                accountSummary={linkedAccountBalances[account.id]}
                performance={linkedAccountPerformance[account.id]}
                connectPnl={connectPnlByAccountId[account.id] ?? null}
                onToggleActive={is_active => { void toggleBrokerActive(account.id, is_active) }}
                toggleDisabled={togglingBrokerId === account.id}
                showReconnect={brokerCanReconnect(account)}
                isReconnecting={isBrokerReconnecting(account.id)}
                onReconnect={() => { void _reconnectBroker(account.id) }}
                onOpenStats={() =>
                  navigate(`/dashboard/broker/${account.id}`, {
                    state: { accountPreview: brokerStatsPreviewFromAccount(account) },
                  })
                }
              />
            ))}
          </div>
        )}
        </div>
        </div>
      </div>

        </>
      )}

      <Outlet />

      <OpenPnlAccountsModal
        open={openPnlModalOpen}
        groups={portfolioActiveSignalGroups}
        totalOpenPnl={stats.openPnl}
        accountCount={openPnlAccountCount}
        onClose={() => setOpenPnlModalOpen(false)}
        onRefresh={() => loadDashboardLiveRef.current()}
      />
    </PageShell>
  )
}

function StatBlock({ label, labelHint, value, sub, subColor, valueColor = 'text-neutral-900 dark:text-neutral-50' }: {
  label: string
  labelHint?: string
  value: string
  sub: ReactNode
  subColor: string
  valueColor?: string
}) {
  return (
    <div className="px-4 py-4 sm:px-6 sm:py-5">
      <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mb-1.5 sm:mb-2 inline-flex items-center gap-1">
        {label}
        {labelHint ? <InfoTooltip text={labelHint} /> : null}
      </p>
      <p className={clsx('text-xl sm:text-2xl font-semibold mb-1 sm:mb-1.5', valueColor)}>{value}</p>
      {sub === '' ? null : typeof sub === 'string' ? (
        <p className={`text-xs ${subColor}`}>{sub}</p>
      ) : (
        <div className="text-xs">{sub}</div>
      )}
    </div>
  )
}

function OverviewStat({
  label,
  value,
  sub,
  addTo,
  onAdd,
  addLabel,
}: {
  label: string
  value: string
  sub?: string
  addTo?: string
  onAdd?: () => void
  addLabel?: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-xs text-neutral-500 dark:text-neutral-400 min-w-0">{label}</p>
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            aria-label={addLabel ?? `Add ${label}`}
            className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md border border-teal-200 dark:border-teal-800 text-teal-600 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/50 hover:border-teal-300 dark:hover:border-teal-700 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        ) : addTo ? (
          <Link
            to={addTo}
            aria-label={addLabel ?? `Go to ${label}`}
            className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md border border-teal-200 dark:border-teal-800 text-teal-600 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/50 hover:border-teal-300 dark:hover:border-teal-700 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </Link>
        ) : null}
      </div>
      <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">{value}</p>
      {sub ? <p className="text-xs text-neutral-400 mt-1">{sub}</p> : null}
    </div>
  )
}

function LogRow({ signal, channelName, symbol }: { signal: Signal; channelName: string; symbol: string }) {
  const t = useT()
  const parsed = signal.parsed_data as Record<string, unknown> | null
  const action = parsed?.action as string | undefined

  const statusConfig: Record<string, { color: string; label: string }> = {
    executed: { color: 'text-teal-700 bg-teal-50 dark:text-teal-300 dark:bg-teal-950/60', label: t.copierLogs.statusExecuted },
    skipped:  { color: 'text-warning-800 bg-warning-50 dark:!text-amber-100 dark:!bg-amber-900', label: t.copierLogs.statusSkipped },
    failed:   { color: 'text-error-800 bg-error-50 dark:text-error-300 dark:bg-error-950/70', label: t.copierLogs.statusFailed },
    pending:  { color: 'text-neutral-600 bg-neutral-100 dark:text-neutral-300 dark:bg-neutral-800', label: t.copierLogs.statusPending },
    parsed:   { color: 'text-teal-700 bg-teal-50 dark:text-teal-300 dark:bg-teal-950/60', label: t.copierLogs.statusParsed },
  }

  const s = statusConfig[signal.status] ?? { color: 'text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800', label: signal.status }
  const isBuy = action === 'buy'

  const typeLabel = action ? action.replace(/_/g, ' ') : '—'

  return (
    <div className={`${DASHBOARD_COPIER_LOG_GRID} px-4 sm:px-5 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors`}>
      <span className={`inline-flex w-fit items-center px-2 py-0.5 rounded-md text-xs font-medium ${s.color}`}>
        {s.label}
      </span>
      <span className="min-w-0 text-xs text-neutral-500 dark:text-neutral-400 truncate" title={channelName}>{channelName}</span>
      <span className="min-w-0 text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate" title={symbol}>{symbol}</span>
      <span
        className={`min-w-0 text-xs font-medium uppercase truncate ${
          isBuy ? 'text-primary-600' : action === 'sell' ? 'text-error-600' : 'text-neutral-600 dark:text-neutral-400'
        }`}
        title={typeLabel}
      >
        {typeLabel}
      </span>
      <span className="text-xs text-neutral-400 text-right whitespace-nowrap tabular-nums">
        {signal.created_at
          ? new Date(signal.created_at).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '—'}
      </span>
    </div>
  )
}

function formatPerformancePct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

function LinkedAccountSortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  title,
  align = 'left',
}: {
  label: string
  sortKey: LinkedAccountSortKey
  activeKey: LinkedAccountSortKey | null
  direction: SortDirection
  onSort: (key: LinkedAccountSortKey) => void
  title?: string
  align?: 'left' | 'right'
}) {
  const isActive = activeKey === sortKey
  const SortIcon = isActive
    ? direction === 'asc'
      ? ChevronUp
      : ChevronDown
    : ChevronsUpDown

  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      title={title}
      className={`inline-flex min-w-0 items-center gap-0.5 rounded-md transition-colors hover:text-neutral-600 dark:hover:text-neutral-300 ${
        align === 'right' ? 'ml-auto justify-end' : 'justify-start'
      } ${isActive ? 'text-neutral-700 dark:text-neutral-200' : 'text-neutral-400'}`}
    >
      <span className="truncate">{label}</span>
      <SortIcon
        className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-teal-600 dark:text-teal-400' : 'opacity-50'}`}
        aria-hidden
      />
    </button>
  )
}

function LinkedAccountRow({
  account,
  accountSummary,
  performance,
  connectPnl,
  onToggleActive,
  toggleDisabled,
  showReconnect,
  isReconnecting,
  onReconnect,
  onOpenStats,
}: {
  account: BrokerAccount
  accountSummary?: { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: LinkedAccountType; open_pnl?: number }
  performance?: LinkedAccountPerformance
  /** Balance P/L since first connect; null when baseline or balance is unavailable. */
  connectPnl?: number | null
  onToggleActive: (is_active: boolean) => void
  toggleDisabled?: boolean
  showReconnect?: boolean
  isReconnecting?: boolean
  onReconnect?: () => void
  onOpenStats: () => void
}) {
  const t = useT()
  const la = t.dashboard.linkedAccounts
  const { locale } = useLocale()
  const intlLocale = locale === 'en' ? undefined : locale
  const isDisconnected = !isBrokerSessionConnected(account)
  const statusClass = isDisconnected
    ? 'text-neutral-700 border-neutral-200 bg-neutral-100 dark:text-neutral-300 dark:border-neutral-700 dark:bg-neutral-800/80'
    : account.is_active
      ? 'text-teal-700 border-teal-200 bg-teal-50 dark:text-teal-300 dark:border-teal-800 dark:bg-teal-950/50'
      : 'text-neutral-600 border-neutral-200 bg-neutral-100 dark:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800/80'
  const balance = accountSummary?.balance ?? account.last_balance ?? null
  const accountCurrency = (accountSummary?.currency ?? account.last_currency ?? '').trim() || undefined
  const balanceText = formatMoneyWithCode(balance, accountCurrency, { locale: intlLocale })
  const pnl = connectPnl ?? 0
  const pnlColor = pnlSignTextClass
  const pnlFormatted = formatMoneyWithCode(Math.abs(pnl), accountCurrency, { locale: intlLocale, nullAsDash: false })
  const openPnl = resolveAccountOpenPnl(account, accountSummary)
  const openPnlColor =
    openPnl == null
      ? 'text-neutral-900 dark:text-neutral-50'
      : pnlSignTextClass(openPnl)
  const openPnlFormatted = formatMoneyWithCode(
    openPnl == null ? null : Math.abs(openPnl),
    accountCurrency,
    { locale: intlLocale, nullAsDash: false },
  )
  const apiRaw = (accountSummary?.broker ?? '').trim()
  const fromApi = inferBrokerLabelFromServer(apiRaw) || apiRaw
  const server = resolveMtServerCandidate(account, accountSummary?.mt_server_hint)
  const fromServer = inferBrokerLabelFromServer(server) || (server?.trim() ?? '')
  const brokerText = fromApi || fromServer || '—'
  const accountType: LinkedAccountType | '—' =
    accountSummary?.account_type
    ?? resolveLinkedAccountTypeForBroker(account, undefined, accountSummary?.mt_server_hint)
    ?? '—'
  const accountTypeClass = linkedAccountTypeValueClass(accountType === '—' ? undefined : accountType)

  const accountLabel = account.label || la.unnamedAccount
  const platformLabel = (account.platform ?? '').trim().toUpperCase() || '—'
  const accountLogin = resolveAccountLogin(account)
  const platformLine = accountLogin ? `${platformLabel} • ${accountLogin}` : platformLabel
  const accountTypeLabel =
    accountType === '—'
      ? accountType
      : formatLinkedAccountTypeLabel(accountType, {
          demo: la.accountTypeDemo,
          live: la.accountTypeLive,
          propFirm: la.accountTypePropFirm,
        })
  const winRate = performance?.winRate ?? null
  const maxDd = performance?.maxDrawdownPct ?? null
  const winRateColor =
    winRate == null ? 'text-neutral-900 dark:text-neutral-50' : winRate >= 50 ? 'text-teal-600' : 'text-neutral-900 dark:text-neutral-50'
  const ddColor =
    maxDd == null ? 'text-neutral-900 dark:text-neutral-50' : lossTextClass

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenStats}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenStats()
        }
      }}
      className="grid grid-cols-9 gap-2 px-4 sm:px-5 py-3 items-center hover:bg-teal-50 dark:hover:bg-teal-950/40 transition-colors cursor-pointer"
    >
      <div className="flex flex-col min-w-0">
        <span
          className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 truncate"
          title={accountLabel}
        >
          {accountLabel}
        </span>
        <span
          className="text-[11px] font-medium text-primary-600 uppercase tabular-nums truncate"
          title={platformLine}
        >
          {platformLine}
        </span>
      </div>
      <span
        className="min-w-0 text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate"
        title={brokerText}
      >
        {brokerText}
      </span>
      <span className={`text-sm font-semibold ${accountTypeClass}`}>{accountTypeLabel}</span>
      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{balanceText}</span>
      <span className={`text-sm font-semibold ${pnlColor}`}>
        {connectPnl == null ? '—' : (
          <>
            {pnl >= 0 ? '+' : '-'}
            {pnlFormatted}
          </>
        )}
      </span>
      <span className={`text-sm font-semibold tabular-nums ${openPnlColor}`}>
        {openPnl == null ? '—' : (
          <>
            {openPnl >= 0 ? '+' : '-'}
            {openPnlFormatted}
          </>
        )}
      </span>
      <span className={`text-sm font-semibold tabular-nums ${winRateColor}`}>{formatPerformancePct(winRate, 0)}</span>
      <span className={`text-sm font-semibold tabular-nums ${ddColor}`}>{formatPerformancePct(maxDd)}</span>
      <div className="flex justify-end items-center gap-2">
        {showReconnect ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={isReconnecting}
            onClick={e => {
              e.stopPropagation()
              onReconnect?.()
            }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {la.reconnect}
          </Button>
        ) : null}
        <span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
          <Toggle
            checked={account.is_active}
            onChange={onToggleActive}
            disabled={toggleDisabled}
          />
        </span>
        <span className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-xs font-semibold ${statusClass}`}>
          {brokerConnectionStatusLabel(account, la)}
        </span>
      </div>
    </div>
  )
}
