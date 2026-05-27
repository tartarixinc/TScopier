import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Clock, ChevronRight, Info, Plus, RefreshCw } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import type { BrokerAccount, Signal, Trade } from '../../types/database'
import {
  inferBrokerLabelFromServer,
  resolveAccountLogin,
  resolveLinkedAccountType,
  resolveMtServerCandidate,
  type LinkedAccountType,
} from '../../lib/brokerFromServer'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { AddAccountModal } from '../../components/ui/AddAccountModal'
import { Toggle } from '../../components/ui/Toggle'
import { Button } from '../../components/ui/Button'
import { metatraderApi, type MtTrade } from '../../lib/metatraderapi'
import { formatLocalCalendarDay } from '../../lib/dayStartBalance'
import { formatLocalMtApiDateTime, isMtTimestampInRange } from '../../lib/mtApiDateTime'
import {
  computeLinkedAccountPerformanceMap,
  countClosedTradeOutcomesInRange,
  getLocalCalendarDayBounds,
  isTradeableClosedRow,
  netClosedLegProfit,
  type LinkedAccountPerformance,
  type TradeStatsRow,
} from '../../lib/dashboardTradeStats'
import {
  buildCopierLogSymbolLabels,
  buildSignalSymbolLookup,
} from '../../lib/copierLogDisplay'
import { channelWorkerLogMessage } from '../../lib/channelWorkerLogMessage'
import {
  DASHBOARD_ACTIVE_USER_KEY,
  DASHBOARD_CACHE_LEGACY_KEYS,
  DASHBOARD_CACHE_VERSION,
  clearDashboardSessionCache,
} from '../../lib/dashboardSessionCache'
import {
  buildAccountGrowthSeries,
  buildTradeVolume7Day,
  findTodayTradeOutcomeDay,
  findYesterdayTradeOutcomeDay,
  netPnlFromTradeOutcomeDay,
  summarizeTodayFromChartTrades,
  resolveDashboardChartTrades,
  DASHBOARD_CHART_MT_HISTORY_DAYS,
  sumClosedDealProfitByBroker,
  type DashboardChartTrade,
} from '../../lib/dashboardCharts'
import { AccountGrowthChart } from '../../components/dashboard/AccountGrowthChart'
import { TradeVolumeChart } from '../../components/dashboard/TradeVolumeChart'
import { useDashboardRealtime } from '../../hooks/useDashboardRealtime'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { BROKER_ACCOUNT_CLIENT_SELECT } from '../../lib/brokerAccountSelect'
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
import { formatMoneyWithCode } from '../../lib/currency'
import { interpolate } from '../../i18n/interpolate'
import { SubscriptionBanner } from '../../components/billing/SubscriptionBanner'

/** Shared column template for dashboard Copier Logs header + rows. */
const DASHBOARD_COPIER_LOG_GRID =
  'grid grid-cols-[5.75rem_minmax(0,1fr)_minmax(4rem,0.85fr)_minmax(4.75rem,auto)_minmax(6.75rem,auto)] gap-x-3 items-center'

interface DashboardStats {
  accounts: number
  portfolioValue: number
  totalEquity: number
  tradesTaken: number
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
  /** Sum of (equity − performance_baseline_balance) across linked brokers with a baseline; null if none. */
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

interface AiExpertLogRow {
  id: string
  created_at: string
  action: string
  status: string
  request_payload: Record<string, unknown> | null
  response_payload: Record<string, unknown> | null
  error_message: string | null
  signal_id?: string | null
  /** FK embed from trade_execution_logs → signals */
  signals?: {
    parsed_data?: Record<string, unknown> | null
    raw_message?: string | null
    status?: string | null
    skip_reason?: string | null
  } | null
}

/** Drop in-flight `attempt` rows when the same `signal_id` already has a terminal parse row in this batch (worker logs attempt then success/failed). */
type ChannelNameRow = { id: string; display_name: string; channel_username?: string | null }

function buildChannelDisplayNames(channels: ChannelNameRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of channels) {
    const name = c.display_name?.trim()
    const username = c.channel_username?.trim().replace(/^@/, '')
    out[c.id] = name || (username ? `@${username}` : 'Unnamed channel')
  }
  return out
}

function channelLabel(channelId: string | null | undefined, names: Record<string, string>): string {
  if (!channelId) return '—'
  return names[channelId] ?? 'Unknown channel'
}

function dedupePipelineParseAttempts(logs: AiExpertLogRow[]): AiExpertLogRow[] {
  const terminalSignalIds = new Set(
    logs
      .filter(
        r =>
          r.action === 'pipeline_parse_dispatch' &&
          (r.status === 'success' || r.status === 'failed') &&
          r.signal_id,
      )
      .map(r => String(r.signal_id)),
  )
  return logs.filter(r => {
    if (
      r.action === 'pipeline_parse_dispatch' &&
      r.status === 'attempt' &&
      r.signal_id &&
      terminalSignalIds.has(String(r.signal_id))
    ) {
      return false
    }
    return true
  })
}

/** Sum of (current equity − performance baseline) per linked broker that has a baseline set. */
function aggregateTotalProfitFromBaselines(
  accounts: BrokerAccount[],
  equityResolver: (account: BrokerAccount) => number,
): number | null {
  let sum = 0
  let n = 0
  for (const a of accounts) {
    const raw = a.performance_baseline_balance
    if (raw == null) continue
    const base = Number(raw)
    if (!Number.isFinite(base)) continue
    const eq = equityResolver(a)
    if (!Number.isFinite(eq)) continue
    sum += eq - base
    n++
  }
  return n > 0 ? sum : null
}

function formatMtApiDateTime(d: Date): string {
  return formatLocalMtApiDateTime(d)
}

function hasActiveMtBroker(accounts: BrokerAccount[]): boolean {
  return accounts.some(b => {
    const uuid = (b.metaapi_account_id ?? '').trim()
    return b.is_active && uuid.length > 0 && !uuid.includes('|')
  })
}

type BrokerBalanceSnapshot = {
  balance?: number
  equity?: number
  currency?: string
  broker?: string
  mt_server_hint?: string
  account_type?: 'Live' | 'Demo'
  open_pnl?: number
  open_trades?: number
}

function isBrokerLiveConnected(account: Pick<BrokerAccount, 'connection_status'>): boolean {
  return isBrokerSessionConnected(account)
}

/** Sum open positions only from brokers with a live connected session. */
function sumConnectedOpenTrades(
  accounts: BrokerAccount[],
  balances: Record<string, BrokerBalanceSnapshot>,
): number {
  return accounts.reduce((sum, account) => {
    if (!isBrokerLiveConnected(account)) return sum
    const n = balances[account.id]?.open_trades
    return sum + (typeof n === 'number' && Number.isFinite(n) ? n : 0)
  }, 0)
}

function hasConnectedBrokerOpenTrades(
  accounts: BrokerAccount[],
  balances: Record<string, BrokerBalanceSnapshot>,
): boolean {
  return accounts.some(
    account =>
      isBrokerLiveConnected(account) && typeof balances[account.id]?.open_trades === 'number',
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
): Record<string, BrokerBalanceSnapshot> {
  const connected = new Set(accounts.filter(isBrokerLiveConnected).map(a => a.id))
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
}

const DEFAULT_DASHBOARD_STATS: DashboardStats = {
  accounts: 0,
  portfolioValue: 0,
  totalEquity: 0,
  tradesTaken: 0,
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

function readBootstrapDashboardCache(expectedUserId: string | null | undefined): DashboardCachePayload | null {
  if (typeof sessionStorage === 'undefined' || !expectedUserId) return null
  const userId = sessionStorage.getItem(DASHBOARD_ACTIVE_USER_KEY)
  if (!userId || userId !== expectedUserId) return null
  return readDashboardCache(userId)
}

function statsFromDashboardCache(cached: DashboardCachePayload | null): DashboardStats {
  if (!cached?.stats) return DEFAULT_DASHBOARD_STATS
  const accounts = cached.linkedAccounts ?? []
  const balances = cached.linkedAccountBalances ?? {}
  const openTrades = hasConnectedBrokerOpenTrades(accounts, balances)
    ? sumConnectedOpenTrades(accounts, balances)
    : 0
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
  const keepNum = (p: number, n: number) => (Number.isFinite(n) && !(n === 0 && p !== 0) ? n : p)
  const keepOpenCount = (p: number, n: number) =>
    opts?.trustOpenTrades ? (Number.isFinite(n) ? n : p) : (Number.isFinite(n) ? n : p)
  const keepStr = (p: string, n: string) => (n === '—' && p !== '—' ? p : n)
  return {
    ...next,
    totalEquity: keepNum(prev.totalEquity, next.totalEquity),
    portfolioValue: keepNum(prev.portfolioValue, next.portfolioValue),
    openPnl: keepNum(prev.openPnl, next.openPnl),
    openPositions: keepOpenCount(prev.openPositions, next.openPositions),
    openTrades: keepOpenCount(prev.openTrades, next.openTrades),
    todayProfit: keepNum(prev.todayProfit, next.todayProfit),
    yesterdayProfit: keepNum(prev.yesterdayProfit, next.yesterdayProfit),
    tradesTaken: keepNum(prev.tradesTaken, next.tradesTaken),
    tradesWon: keepNum(prev.tradesWon, next.tradesWon),
    tradesLost: keepNum(prev.tradesLost, next.tradesLost),
    tradesBreakeven: keepNum(prev.tradesBreakeven, next.tradesBreakeven),
    totalVolume: keepNum(prev.totalVolume, next.totalVolume),
    yesterdayTotalVolume: keepNum(prev.yesterdayTotalVolume, next.yesterdayTotalVolume),
    bestTradeProfit: keepNum(prev.bestTradeProfit, next.bestTradeProfit),
    yesterdayBestTradeProfit: keepNum(prev.yesterdayBestTradeProfit, next.yesterdayBestTradeProfit),
    worstTradeProfit:
      next.worstTradeProfit === 0 && prev.worstTradeProfit < 0 ? prev.worstTradeProfit : next.worstTradeProfit,
    yesterdayWorstTradeProfit:
      next.yesterdayWorstTradeProfit === 0 && prev.yesterdayWorstTradeProfit < 0
        ? prev.yesterdayWorstTradeProfit
        : next.yesterdayWorstTradeProfit,
    mostTradedAsset: keepStr(prev.mostTradedAsset, next.mostTradedAsset),
    yesterdayMostTradedAsset: keepStr(prev.yesterdayMostTradedAsset, next.yesterdayMostTradedAsset),
    mostProfitableChannel: keepStr(prev.mostProfitableChannel, next.mostProfitableChannel),
    yesterdayMostProfitableChannel: keepStr(
      prev.yesterdayMostProfitableChannel,
      next.yesterdayMostProfitableChannel,
    ),
  }
}

function preferChartTrades(prev: DashboardChartTrade[], next: DashboardChartTrade[]): DashboardChartTrade[] {
  return next.length > 0 ? next : prev
}

function writeDashboardCache(userId: string, payload: DashboardCachePayload) {
  sessionStorage.setItem(DASHBOARD_ACTIVE_USER_KEY, userId)
  sessionStorage.setItem(`${DASHBOARD_CACHE_VERSION}:${userId}`, JSON.stringify(payload))
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
      return JSON.parse(raw) as DashboardCachePayload
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

export function DashboardPage() {
  const t = useT()
  const la = t.dashboard.linkedAccounts
  const { user } = useAuth()
  const {
    brokers: linkedAccounts,
    setBrokers,
    patchBroker,
    replaceBroker,
    toggleBrokerActive: toggleBrokerActiveInStore,
    reconnectBroker,
    brokersNeedingReconnect,
    isReconnecting: isBrokerReconnecting,
    setReconnectErrorHandler,
    setReconnectSuccessHandler,
  } = useBrokerAccounts()
  const { formatMoney, formatSignedMoney } = useFormatMoney()
  const navigate = useNavigate()
  const bootCache = useMemo(() => readBootstrapDashboardCache(user?.id), [user?.id])
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
  const [chartTrades, setChartTrades] = useState<DashboardChartTrade[]>(() => bootCache?.chartTrades ?? [])
  const chartTradesRef = useRef(chartTrades)
  chartTradesRef.current = chartTrades
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [togglingBrokerId, setTogglingBrokerId] = useState<string | null>(null)
  const [brokerReconnectError, setBrokerReconnectError] = useState('')
  const loadDashboardLiveRef = useRef<() => void>(() => {})
  /** Background MT/broker poll — DB changes use Supabase Realtime instead. */
  const MT_LIVE_REFRESH_MS = 45_000
  const BROKER_SUMMARY_REFRESH_MS = 30_000
  const MT_TRADES_REFRESH_MS = 30_000
  const lastBrokerRefreshRef = useRef<number>(0)
  const lastMtTradesRefreshRef = useRef<number>(0)
  /** Ignore stale responses when a newer *fresh* loadDashboard run started. */
  const loadGenerationRef = useRef(0)
  const dashboardReadyRef = useRef(Boolean(bootCache?.stats))
  const bootHasMtBroker = bootCache?.linkedAccounts?.some(b => {
    const uuid = (b.metaapi_account_id ?? '').trim()
    return b.is_active && uuid.length > 0 && !uuid.includes('|')
  })
  const [dashboardChartsReady, setDashboardChartsReady] = useState(() => {
    if (!bootCache) return false
    if ((bootCache.chartTrades?.length ?? 0) > 0 || (bootCache.mtTrades?.length ?? 0) > 0) return true
    return !bootHasMtBroker
  })
  const linkedBalancesRef = useRef<Record<string, BrokerBalanceSnapshot>>(bootCache?.linkedAccountBalances ?? {})
  const refreshQuietRef = useRef<() => void>(() => {})
  /** Last successful MT trades response, kept across renders so stats survive throttled refresh windows. */
  const mtTradesRef = useRef<MtTrade[] | null>(bootCache?.mtTrades ?? null)
  /**
   * Last known MT live values per broker id, kept across `loadDashboard` calls so
   * the auto-refresh tick (15s) doesn't bounce stats back to DB defaults while
   * `refreshBrokerSummaries` is between throttled runs (30s). Without this the
   * Active Trades stat fluctuates 0/1 between ticks.
   */
  const liveBrokerStateRef = useRef<Record<string, { open_pnl?: number; open_trades?: number }>>({})
  if (bootCache?.linkedAccountBalances && Object.keys(liveBrokerStateRef.current).length === 0) {
    seedLiveBrokerStateFromBalances(
      bootCache.linkedAccountBalances,
      liveBrokerStateRef.current,
      bootCache.linkedAccounts,
    )
  }
  const hydratedUserRef = useRef<string | null>(null)
  const statsRef = useRef(stats)
  useEffect(() => {
    statsRef.current = stats
  }, [stats])

  useEffect(() => {
    if (!user?.id) return
    if (hydratedUserRef.current === user.id) return
    const previousUser = hydratedUserRef.current
    hydratedUserRef.current = user.id
    if (previousUser && previousUser !== user.id) {
      clearDashboardSessionCache(previousUser)
    }
    liveBrokerStateRef.current = {}
    mtTradesRef.current = null
    linkedBalancesRef.current = {}
    const cached = readDashboardCache(user.id)
    if (cached?.stats) {
      setStats(statsFromDashboardCache(cached))
      setCopierLogs(cached.copierLogs ?? [])
      setCopierLogSymbols(cached.copierLogSymbols ?? {})
      setChannelDisplayNames(cached.channelDisplayNames ?? {})
      const balances = cached.linkedAccountBalances ?? {}
      linkedBalancesRef.current = balances
      setLinkedAccountBalances(balances)
      if (cached.chartTrades?.length) {
        setChartTrades(cached.chartTrades)
      } else if (cached.mtTrades?.length) {
        setChartTrades(resolveDashboardChartTrades(cached.mtTrades, []))
      }
      if (cached.aiExpertLogs?.length) setAiExpertLogs(cached.aiExpertLogs)
      if (cached.mtTrades?.length) mtTradesRef.current = cached.mtTrades
      seedLiveBrokerStateFromBalances(balances, liveBrokerStateRef.current, cached.linkedAccounts)
      if ((cached.chartTrades?.length ?? 0) > 0 || (cached.mtTrades?.length ?? 0) > 0) {
        setDashboardChartsReady(true)
      }
    } else {
      setStats(DEFAULT_DASHBOARD_STATS)
      setCopierLogs([])
      setCopierLogSymbols({})
      setChannelDisplayNames({})
      setLinkedAccountBalances({})
      setChartTrades([])
      setAiExpertLogs([])
    }
    dashboardReadyRef.current = Boolean(cached?.stats)
  }, [user?.id])

  /** Keep last chart snapshot visible while a refresh briefly returns empty data. */
  const effectiveChartTrades = useMemo(() => {
    if (chartTrades.length > 0) return chartTrades
    const sticky = chartTradesRef.current
    return sticky.length > 0 ? sticky : chartTrades
  }, [chartTrades])

  const tradeVolume7Day = useMemo(
    () => buildTradeVolume7Day(effectiveChartTrades),
    [effectiveChartTrades],
  )

  const todayOutcomeDay = useMemo(
    () => findTodayTradeOutcomeDay(effectiveChartTrades),
    [effectiveChartTrades],
  )

  const yesterdayOutcomeDay = useMemo(
    () => findYesterdayTradeOutcomeDay(effectiveChartTrades),
    [effectiveChartTrades],
  )

  const todayChartStats = useMemo(
    () => summarizeTodayFromChartTrades(effectiveChartTrades),
    [effectiveChartTrades],
  )

  const closedProfitByAccountId = useMemo(
    () => sumClosedDealProfitByBroker(effectiveChartTrades),
    [effectiveChartTrades],
  )

  const hasMtTradeHistory = effectiveChartTrades.length > 0

  /** Headline stats: today/yesterday P/L match Trade Outcome bars (profit − loss). */
  const headlineStats = useMemo(() => {
    const chartHasToday = todayChartStats.hasData
    const todayProfit = chartHasToday
      ? netPnlFromTradeOutcomeDay(todayOutcomeDay)
      : stats.todayProfit
    const yesterdayProfit = chartHasToday || effectiveChartTrades.length > 0
      ? netPnlFromTradeOutcomeDay(yesterdayOutcomeDay)
      : stats.yesterdayProfit
    return {
      ...stats,
      todayProfit,
      yesterdayProfit,
      tradesTaken: chartHasToday ? todayChartStats.taken : stats.tradesTaken,
      tradesWon: chartHasToday ? todayChartStats.won : stats.tradesWon,
      tradesLost: chartHasToday ? todayChartStats.lost : stats.tradesLost,
      tradesBreakeven: chartHasToday ? todayChartStats.breakeven : stats.tradesBreakeven,
    }
  }, [stats, todayChartStats, todayOutcomeDay, yesterdayOutcomeDay, effectiveChartTrades.length])

  const openPnlSub = useMemo(() => {
    let accountCount = countAccountsWithOpenPositions(
      linkedAccounts,
      linkedAccountBalances,
      mtTradesRef.current,
    )
    if (accountCount === 0 && stats.openTrades > 0) {
      const brokers = new Set(
        effectiveChartTrades.filter(t => t.status === 'open').map(t => t.brokerAccountId),
      )
      accountCount = brokers.size
    }
    if (accountCount === 0) return t.dashboard.openPnlNoOpen
    if (accountCount === 1) return t.dashboard.openPnlAcrossOneAccount
    return interpolate(t.dashboard.openPnlAcrossAccounts, { count: String(accountCount) })
  }, [linkedAccounts, linkedAccountBalances, effectiveChartTrades, stats.openTrades, t])

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

  const balanceByAccountId = useMemo(() => {
    const out: Record<string, number> = {}
    for (const account of linkedAccounts) {
      const live = linkedAccountBalances[account.id]
      const bal = live?.balance ?? account.last_balance ?? live?.equity ?? account.last_equity
      if (bal != null && Number.isFinite(Number(bal))) {
        out[account.id] = Number(bal)
      }
    }
    return out
  }, [linkedAccounts, linkedAccountBalances])

  const accountGrowth = useMemo(
    () => buildAccountGrowthSeries(linkedAccounts, effectiveChartTrades, balanceByAccountId, 7),
    [linkedAccounts, effectiveChartTrades, balanceByAccountId],
  )

  const accountGrowthEmpty = accountGrowth.series.length === 0

  const linkedAccountPerformance = useMemo(() => {
    const tradesByAccountId: Record<string, TradeStatsRow[]> = {}
    const mtTrades = mtTradesRef.current
    if (mtTrades && mtTrades.length > 0) {
      for (const t of mtTrades) {
        const row: TradeStatsRow = {
          status: t.status,
          profit: t.profit,
          closed_at: t.closed_at,
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
  }, [linkedAccounts, effectiveChartTrades, equityByAccountId])

  const formatVsYesterdayMoney = (yesterdayValue: number | null | undefined) => {
    if (yesterdayValue == null || !Number.isFinite(yesterdayValue)) return ''
    return `vs yesterday: ${formatMoney(yesterdayValue)}`
  }

  const loadDashboard = async (opts: { fresh?: boolean; syncLive?: boolean } = {}) => {
    const { fresh = false, syncLive = fresh } = opts
    const generation = fresh ? ++loadGenerationRef.current : loadGenerationRef.current
    try {
    const { todayStart, tomorrowStart, yesterdayStart } = getLocalCalendarDayBounds()

    const [brokerRes, channelsRes, tradesRes, todaySignalsRes, yesterdaySignalsRes, logsRes, allSignalsRes, channelsMetaRes, aiLogsRes] = await Promise.all([
      supabase.from('broker_accounts').select(BROKER_ACCOUNT_CLIENT_SELECT).eq('user_id', user!.id),
      supabase.from('telegram_channels').select('id').eq('user_id', user!.id).eq('is_active', true),
      supabase.from('trades').select('*').eq('user_id', user!.id),
      supabase.from('signals').select('status').eq('user_id', user!.id).gte('created_at', todayStart.toISOString()).lt('created_at', tomorrowStart.toISOString()),
      supabase.from('signals').select('status').eq('user_id', user!.id).gte('created_at', yesterdayStart.toISOString()).lt('created_at', todayStart.toISOString()),
      supabase.from('signals').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }).limit(10),
      supabase.from('signals').select('id,channel_id').eq('user_id', user!.id),
      supabase.from('telegram_channels').select('id,display_name,channel_username').eq('user_id', user!.id),
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
          signals ( raw_message, parsed_data, status, skip_reason )
        `,
        )
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ])

    const allTrades = (tradesRes.data ?? []) as Trade[]
    const openTrades = allTrades.filter(t => t.status === 'open')
    const todaySignals = (todaySignalsRes.data ?? []) as { status: string }[]
    const copiedToday = todaySignals.filter(s => s.status === 'executed' || s.status === 'parsed').length
    const openPnlFromTrades = openTrades.reduce((sum, t) => sum + (t.profit ?? 0), 0)
    const isInRange = (dateString: string | null | undefined, start: Date, end: Date) =>
      isMtTimestampInRange(dateString, start, end)

    // Prefer live MT trades when we have a cached snapshot; otherwise use the
    // local `trades` table. The live snapshot is refreshed in the background.
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
    const closedOutcomesToday = countClosedTradeOutcomesInRange(sourceTrades, closedTodayForStats)

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
    const brokerAccounts = (brokerRes.data ?? []) as unknown as BrokerAccount[]
    const mtBrokerConnected = hasActiveMtBroker(brokerAccounts)
    const activeBrokerCount = brokerAccounts.filter(account => account.is_active).length
    // Seed the balance map from the cached columns the worker / edge function
    // wrote on AccountSummary. This is what makes the page render instantly
    // without waiting for a live MetatraderAPI roundtrip on every page load.
    const balanceMap = Object.fromEntries(
      brokerAccounts.map((account) => {
        // Best-effort Open PnL on first paint: MT reports equity = balance + floating P/L,
        // so until the live /AccountSummary refresh lands we approximate from cached fields.
        const cachedOpenPnl =
          account.last_equity != null && account.last_balance != null
            ? account.last_equity - account.last_balance
            : undefined
        // Re-apply the last MT live values we've already fetched this session so
        // the stat doesn't bounce between throttled refresh windows.
        const sticky = liveBrokerStateRef.current[account.id]
        const liveOk = isBrokerLiveConnected(account)
        return [
          account.id,
          {
            balance: account.last_balance ?? undefined,
            equity: account.last_equity ?? undefined,
            currency: account.last_currency ?? undefined,
            broker: account.broker_name ?? undefined,
            mt_server_hint: account.broker_server ?? undefined,
            account_type: resolveLinkedAccountType(
              undefined,
              resolveMtServerCandidate(account, account.broker_server ?? undefined),
            ),
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
    )
    const chartTradesForLoad =
      useMtTrades && mtTrades ? resolveDashboardChartTrades(mtTrades, []) : chartTradesRef.current
    const todayProfit = mtBrokerConnected && !useMtTrades
      ? statsRef.current.todayProfit
      : netPnlFromTradeOutcomeDay(findTodayTradeOutcomeDay(chartTradesForLoad))
    const yesterdayProfit = mtBrokerConnected && !useMtTrades
      ? statsRef.current.yesterdayProfit
      : netPnlFromTradeOutcomeDay(findYesterdayTradeOutcomeDay(chartTradesForLoad))
    /** Lifetime-style total vs baseline balance at link (sum of equity − baseline per account). */
    const yesterdayTotalProfitLoss: number | null = null
    const totalProfitLoss = aggregateTotalProfitFromBaselines(brokerAccounts, (account) => {
      const m = mergedBalances[account.id]
      return Number(m?.equity ?? m?.balance ?? account.last_equity ?? account.last_balance ?? Number.NaN)
    })
    const totalPortfolioValue = brokerAccounts.reduce((sum, account) => {
      const acct = mergedBalances[account.id]
      return sum + (acct?.balance ?? 0)
    }, 0)
    const totalEquityValue = brokerAccounts.reduce((sum, account) => {
      const acct = mergedBalances[account.id]
      return sum + (acct?.equity ?? acct?.balance ?? 0)
    }, 0)
    const totalLiveOpenPnl = brokerAccounts.reduce((sum, account) => {
      if (!isBrokerLiveConnected(account)) return sum
      const acct = mergedBalances[account.id]
      return sum + (acct?.open_pnl ?? 0)
    }, 0)
    const totalLiveOpenTradesFromSummary = sumConnectedOpenTrades(brokerAccounts, mergedBalances)
    const hasAnyBrokerOpenPnl = brokerAccounts.some(
      account => isBrokerLiveConnected(account) && mergedBalances[account.id]?.open_pnl != null,
    )
    const hasAnyBrokerOpenTradesFromSummary = hasConnectedBrokerOpenTrades(brokerAccounts, mergedBalances)
    const resolvedOpenTradesCount =
      hasAnyBrokerOpenTradesFromSummary ? totalLiveOpenTradesFromSummary : openTrades.length
    const channelNames = buildChannelDisplayNames((channelsMetaRes.data ?? []) as ChannelNameRow[])
    const logs = (logsRes.data ?? []) as Signal[]
    const symbolLookup = await buildSignalSymbolLookup(supabase, user!.id, logs)
    const logSymbols = buildCopierLogSymbolLabels(logs, symbolLookup)
    const nextStats: DashboardStats = {
      accounts: activeBrokerCount,
      portfolioValue: totalPortfolioValue,
      totalEquity: totalEquityValue,
      tradesTaken: closedOutcomesToday.taken,
      tradesWon: closedOutcomesToday.won,
      tradesLost: closedOutcomesToday.lost,
      tradesBreakeven: closedOutcomesToday.breakeven,
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
    if (fresh && generation !== loadGenerationRef.current) return

    const aiLogs = dedupePipelineParseAttempts((aiLogsRes.data ?? []) as AiExpertLogRow[])
    const chartFromDb = resolveDashboardChartTrades(hasMtCache ? mtTradesRef.current : null, allTrades)

    const mergedAfterDb = mergeDashboardStats(statsRef.current, nextStats, useMtTrades, {
      trustOpenTrades: hasAnyBrokerOpenTradesFromSummary,
      preserveMtTradeCounts: mtBrokerConnected,
      mtHasClosedTrades: useMtTrades
        ? sourceTrades.some(t => t.status === 'closed')
        : undefined,
    })
    statsRef.current = mergedAfterDb
    setStats(mergedAfterDb)
    setCopierLogs(logs)
    setCopierLogSymbols(logSymbols)
    setChannelDisplayNames(channelNames)
    setBrokers(brokerAccounts)
    linkedBalancesRef.current = mergedBalances
    setLinkedAccountBalances(mergedBalances)
    setAiExpertLogs(aiLogs)
    setChartTrades(prev => {
      const next = preferChartTrades(prev, chartFromDb)
      return next
    })

    if (syncLive) {
      await Promise.allSettled([
        refreshBrokerSummaries(brokerAccounts, mergedBalances, { force: true }),
        refreshMtTrades(brokerAccounts, { force: true }),
      ])
      if (fresh && generation !== loadGenerationRef.current) return
      const chartFromMt = resolveDashboardChartTrades(mtTradesRef.current, allTrades)
      setChartTrades(prev => preferChartTrades(prev, chartFromMt))
      if (user) {
        writeDashboardCache(user.id, {
          stats: statsRef.current,
          copierLogs: logs,
          copierLogSymbols: logSymbols,
          channelDisplayNames: channelNames,
          linkedAccounts: brokerAccounts,
          linkedAccountBalances: linkedBalancesRef.current,
          chartTrades: chartFromMt.length > 0 ? chartFromMt : chartFromDb,
          aiExpertLogs: aiLogs,
          mtTrades: mtTradesRef.current ?? undefined,
        })
      }
    } else if (user) {
      writeDashboardCache(user.id, {
        stats: mergedAfterDb,
        copierLogs: logs,
        copierLogSymbols: logSymbols,
        channelDisplayNames: channelNames,
        linkedAccounts: brokerAccounts,
        linkedAccountBalances: mergedBalances,
        chartTrades: chartFromDb,
        aiExpertLogs: aiLogs,
        mtTrades: mtTradesRef.current ?? undefined,
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
    if (!dashboardReadyRef.current) return
    void loadDashboard({ fresh: false, syncLive: false })
  }

  loadDashboardLiveRef.current = () => {
    if (!dashboardReadyRef.current) return
    void loadDashboard({ fresh: false, syncLive: true })
  }

  const bl = t.accountConfig.brokerList
  const connectErrorLabels = useMemo(() => brokerConnectErrorLabelsFromI18n(bl), [bl])
  const reconnectBannerText = useMemo(
    () => brokerReconnectBannerText(brokersNeedingReconnect, {
      ...connectErrorLabels,
      droppedOne: bl.reconnectDroppedOne,
      droppedMany: bl.reconnectDroppedMany,
    }),
    [brokersNeedingReconnect, connectErrorLabels, bl.reconnectDroppedOne, bl.reconnectDroppedMany],
  )

  useEffect(() => {
    setReconnectErrorHandler(message => setBrokerReconnectError(message))
    setReconnectSuccessHandler(() => loadDashboardLiveRef.current())
    return () => {
      setReconnectErrorHandler(null)
      setReconnectSuccessHandler(null)
    }
  }, [setReconnectErrorHandler, setReconnectSuccessHandler])

  useDashboardRealtime(user?.id, () => refreshQuietRef.current(), broker => {
    replaceBroker(broker)
  })

  useEffect(() => {
    if (!user) return
    void loadDashboard({ fresh: true, syncLive: true })
  }, [user])

  useEffect(() => {
    if (!user) return

    let cancelled = false
    const syncLiveMt = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      await Promise.allSettled([
        refreshBrokerSummaries(undefined, undefined, { force: true }),
        refreshMtTrades(undefined, { force: true }),
      ])
    }

    const interval = window.setInterval(() => {
      void syncLiveMt()
    }, MT_LIVE_REFRESH_MS)

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        lastBrokerRefreshRef.current = 0
        lastMtTradesRefreshRef.current = 0
        void syncLiveMt()
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user])

  /**
   * Pull live trades (open + recent closed) from MetatraderAPI for every linked
   * broker and recompute the performance stats from them. Throttled to one call
   * per MT_TRADES_REFRESH_MS so the 15s auto-tick doesn't hammer the edge fn.
   */
  const refreshMtTrades = async (
    brokerAccounts?: BrokerAccount[],
    opts?: { force?: boolean },
  ) => {
    const now = Date.now()
    if (!opts?.force && now - lastMtTradesRefreshRef.current < MT_TRADES_REFRESH_MS) return
    const sourceAccounts = brokerAccounts ?? linkedAccounts
    const hasMtBroker = sourceAccounts.some((b) => {
      const uuid = (b.metaapi_account_id ?? '').trim()
      return b.is_active && uuid.length > 0 && !uuid.includes('|')
    })
    if (!hasMtBroker) return
    lastMtTradesRefreshRef.current = now

    const { tomorrowStart: dayEnd } = getLocalCalendarDayBounds()
    const historyFrom = new Date()
    historyFrom.setDate(historyFrom.getDate() - DASHBOARD_CHART_MT_HISTORY_DAYS)
    let trades: MtTrade[]
    try {
      const res = await metatraderApi.trades({
        scope: 'all',
        historyProfile: 'dashboard',
        historyFrom: formatMtApiDateTime(historyFrom),
        historyTo: formatMtApiDateTime(dayEnd),
      })
      trades = res.trades ?? []
    } catch {
      return
    }
    if (trades.length > 0) {
      mtTradesRef.current = trades
    }
    const chartNext = resolveDashboardChartTrades(
      trades.length > 0 ? trades : mtTradesRef.current ?? [],
      [],
    )
    setChartTrades(prev => preferChartTrades(prev, chartNext))
    if (trades.length === 0) return

    const { todayStart: today0, tomorrowStart: tomorrow0, yesterdayStart: yesterday0 } =
      getLocalCalendarDayBounds()
    const inRange = (iso: string | null, start: Date, end: Date) =>
      isMtTimestampInRange(iso, start, end)

    const today = trades.filter(t => inRange(t.opened_at, today0, tomorrow0))
    const yesterday = trades.filter(t => inRange(t.opened_at, yesterday0, today0))
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
    const tradeRows: TradeStatsRow[] = trades.filter(t => t.status === 'closed').map(t => ({
      status: t.status ?? 'closed',
      profit: t.profit,
      closed_at: t.closed_at,
      symbol: t.symbol,
      lot_size: t.lot_size,
      direction: t.direction,
      type: t.type,
      swap: t.swap,
      commission: t.commission,
    }))
    const chartToday = summarizeTodayFromChartTrades(chartNext)
    const closedOutcomesToday = chartToday.hasData
      ? {
          taken: chartToday.taken,
          won: chartToday.won,
          lost: chartToday.lost,
          breakeven: chartToday.breakeven,
        }
      : countClosedTradeOutcomesInRange(tradeRows, closedTodayForStats)
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
    const mtStatsPatch: DashboardStats = {
      ...statsRef.current,
      tradesTaken: closedOutcomesToday.taken,
      tradesWon: closedOutcomesToday.won,
      tradesLost: closedOutcomesToday.lost,
      tradesBreakeven: closedOutcomesToday.breakeven,
      todayProfit: netPnlFromTradeOutcomeDay(findTodayTradeOutcomeDay(chartNext)),
      totalVolume: today.reduce((sum, t) => sum + (t.lot_size ?? 0), 0),
      yesterdayTotalVolume: yesterday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0),
      bestTradeProfit: posTodayLeg.length ? Math.max(...posTodayLeg) : 0,
      yesterdayBestTradeProfit: posYestLeg.length ? Math.max(...posYestLeg) : 0,
      worstTradeProfit: negTodayLeg.length ? Math.min(...negTodayLeg) : 0,
      yesterdayWorstTradeProfit: negYestLeg.length ? Math.min(...negYestLeg) : 0,
      yesterdayProfit: netPnlFromTradeOutcomeDay(findYesterdayTradeOutcomeDay(chartNext)),
      mostTradedAsset: topSymbol(today),
      yesterdayMostTradedAsset: topSymbol(yesterday),
    }
    statsRef.current = mtStatsPatch
    setStats(mtStatsPatch)
    if (user) {
      writeDashboardCache(user.id, {
        stats: mtStatsPatch,
        copierLogs,
        copierLogSymbols,
        channelDisplayNames,
        linkedAccounts,
        linkedAccountBalances: linkedBalancesRef.current,
        chartTrades: chartNext.length > 0 ? chartNext : chartTrades,
        aiExpertLogs,
        mtTrades: trades,
      })
    }
  }

  /**
   * Pull live balance/equity from MetatraderAPI for every connected broker and
   * merge the results into local state. Throttled so the auto-refresh ticker
   * doesn't hammer the edge function — at most once per BROKER_SUMMARY_REFRESH_MS.
   */
  const refreshBrokerSummaries = async (
    brokerAccounts?: BrokerAccount[],
    balanceSeed?: Record<string, { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number; open_trades?: number }>,
    opts?: { force?: boolean },
  ) => {
    const now = Date.now()
    if (!opts?.force && now - lastBrokerRefreshRef.current < BROKER_SUMMARY_REFRESH_MS) return
    lastBrokerRefreshRef.current = now

    const sourceAccounts = brokerAccounts ?? linkedAccounts
    const mtBrokers = sourceAccounts.filter((b) => {
      const uuid = (b.metaapi_account_id ?? '').trim()
      // Skip legacy / not-yet-linked rows that don't have a MetatraderAPI uuid.
      return b.is_active && uuid.length > 0 && !uuid.includes('|')
    })
    if (mtBrokers.length === 0) return

    const calendarDay = formatLocalCalendarDay()
    const timezoneOffsetMinutes = new Date().getTimezoneOffset()

    const results = await Promise.all(
      mtBrokers.map(async (b) => {
        try {
          const {
            summary,
            open_positions,
            performance_baseline_balance,
            day_start_balance,
            day_start_balance_on,
            todays_profit_from_balance,
            stale,
          } = await metatraderApi.summary(b.id, { calendarDay, timezoneOffsetMinutes })
          return {
            id: b.id,
            summary,
            open_positions,
            stale: stale === true,
            performance_baseline_balance: performance_baseline_balance ?? null,
            day_start_balance: day_start_balance ?? null,
            day_start_balance_on: day_start_balance_on ?? null,
            todays_profit_from_balance: todays_profit_from_balance ?? null,
            error: null as Error | null,
          }
        } catch (err) {
          return {
            id: b.id,
            summary: null,
            open_positions: null as number | null,
            stale: false,
            performance_baseline_balance: null as number | null,
            day_start_balance: null as number | null,
            day_start_balance_on: null as string | null,
            todays_profit_from_balance: null as number | null,
            error: err instanceof Error ? err : new Error('summary failed'),
          }
        }
      }),
    )

    const prevBalances = balanceSeed ?? linkedAccountBalances
    const nextBalances = { ...prevBalances }
    const successes: typeof results = []
    for (const r of results) {
      const broker = sourceAccounts.find(b => b.id === r.id)
      if (r.error || !r.summary || r.stale) {
        if (broker && (r.error || r.stale || !r.summary)) {
          patchBroker(r.id, { connection_status: 'error' })
        }
        continue
      }
      successes.push(r)
      const s = r.summary
      const server = broker
        ? resolveMtServerCandidate(broker, nextBalances[r.id]?.mt_server_hint ?? broker.broker_server)
        : null
      const accountType = resolveLinkedAccountType(s.type, server)
      const nextBalance = s.balance ?? nextBalances[r.id]?.balance
      const nextEquity = s.equity ?? nextBalances[r.id]?.equity
      const liveProfit =
        s.profit != null
          ? s.profit
          : (nextBalance != null && nextEquity != null ? nextEquity - nextBalance : nextBalances[r.id]?.open_pnl)
      const liveOpenTrades =
        typeof r.open_positions === 'number'
          ? r.open_positions
          : r.stale
            ? 0
            : undefined
      nextBalances[r.id] = {
        ...(nextBalances[r.id] ?? {}),
        balance: nextBalance,
        equity: nextEquity,
        currency: s.currency ?? nextBalances[r.id]?.currency,
        account_type: accountType ?? nextBalances[r.id]?.account_type,
        open_pnl: liveProfit,
        open_trades: liveOpenTrades,
      }
      liveBrokerStateRef.current[r.id] = {
        open_pnl: typeof liveProfit === 'number' ? liveProfit : undefined,
        open_trades: typeof liveOpenTrades === 'number' ? liveOpenTrades : undefined,
      }
    }
    const mergedForDisplay = mergeBrokerBalances(
      nextBalances,
      nextBalances,
      liveBrokerStateRef.current,
      sourceAccounts,
    )
    linkedBalancesRef.current = mergedForDisplay
    setLinkedAccountBalances(mergedForDisplay)

    const sawOpenPosCount = successes.length > 0
    const mtOpenTotal = sumConnectedOpenTrades(sourceAccounts, mergedForDisplay)

    // Recompute portfolio value (pure balance), equity, and open PnL from the freshest snapshot.
    setStats(prev => {
      let portfolioValue = 0
      let totalEquity = 0
      let openPnl = 0
      let sawLivePnl = false
      for (const account of sourceAccounts) {
        const row = successes.find(r => r.id === account.id)
        const live = row?.summary
        const equity = live?.equity ?? account.last_equity ?? account.last_balance ?? 0
        const balance = live?.balance ?? account.last_balance ?? 0
        portfolioValue += balance || 0
        totalEquity += equity || balance || 0
        if (live && isBrokerLiveConnected(account) && !row?.stale) {
          const profit = live.profit ?? (live.equity != null && live.balance != null ? live.equity - live.balance : null)
          if (profit != null && Number.isFinite(profit)) {
            openPnl += profit
            sawLivePnl = true
          }
        }
      }
      const accountsForTotal = sourceAccounts.map(a => {
        const row = successes.find(s => s.id === a.id)
        const fromLive =
          row?.performance_baseline_balance != null && Number.isFinite(Number(row.performance_baseline_balance))
            ? Number(row.performance_baseline_balance)
            : null
        return {
          ...a,
          performance_baseline_balance: fromLive ?? a.performance_baseline_balance ?? null,
        }
      })
      const totalProfitLoss = aggregateTotalProfitFromBaselines(accountsForTotal, account => {
        const row = successes.find(s => s.id === account.id)
        const live = row?.summary
        return Number(
          live?.equity ?? live?.balance ?? account.last_equity ?? account.last_balance ?? Number.NaN,
        )
      })
      const chartTodayProfit = netPnlFromTradeOutcomeDay(findTodayTradeOutcomeDay(chartTradesRef.current))
      const next = {
        ...prev,
        portfolioValue,
        totalEquity,
        openPnl: sawLivePnl ? openPnl : prev.openPnl,
        totalProfitLoss,
        todayProfit:
          chartTradesRef.current.length > 0 || chartTodayProfit !== 0
            ? chartTodayProfit
            : prev.todayProfit,
        ...(sawOpenPosCount ? { openPositions: mtOpenTotal, openTrades: mtOpenTotal } : {}),
      }
      statsRef.current = next
      return next
    })
  }

  const toggleBrokerActive = async (id: string, is_active: boolean) => {
    if (!user) return
    const snapshot = linkedAccounts
    const applyActiveStats = (accounts: BrokerAccount[]) => {
      const activeCount = accounts.filter(a => a.is_active).length
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
    !dashboardChartsReady &&
    effectiveChartTrades.length === 0 &&
    accountGrowth.series.length === 0

  return (
    <PageShell maxWidth="xl" spacing="none" className="space-y-6">
      <PageHeader title={t.dashboard.title} />
      <SubscriptionBanner />

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
            value={formatMoney(headlineStats.todayProfit)}
            sub={formatVsYesterdayMoney(headlineStats.yesterdayProfit)}
            valueColor={
              headlineStats.todayProfit > 0
                ? 'text-teal-600'
                : headlineStats.todayProfit < 0
                  ? 'text-error-600'
                  : 'text-neutral-900 dark:text-neutral-50'
            }
            subColor={headlineStats.todayProfit >= 0 ? 'text-neutral-400' : 'text-error-500'}
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
                  <span className="text-error-500">
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
            sub={openPnlSub}
            valueColor={
              stats.openPnl > 0
                ? 'text-teal-600'
                : stats.openPnl < 0
                  ? 'text-error-600'
                  : 'text-neutral-900 dark:text-neutral-50'
            }
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
            addTo="/account-configuration"
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
        <TradeVolumeChart data={tradeVolume7Day} loading={chartsLoading} />
        <AccountGrowthChart
          data={accountGrowth.data}
          series={accountGrowth.series}
          loading={chartsLoading}
          isEmpty={accountGrowthEmpty && effectiveChartTrades.length === 0}
        />
      </div>

      {/* Lower panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* AI Expert Log */}
          <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 min-w-0">
          <div className="px-4 sm:px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-teal-500" />
              <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{t.dashboard.channelWorker}</span>
              <button className="text-neutral-300 hover:text-neutral-500 dark:text-neutral-400">
                <Info className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={() => navigate('/channels')}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 dark:border-teal-600 text-teal-600 dark:text-teal-400 rounded-lg text-xs font-medium hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
            >
              {t.nav.items.channels}
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          {aiExpertLogs.length === 0 && chartsEmpty ? (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="px-5 py-3">
                  <div className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-3/4 mb-1.5" />
                  <div className="h-3 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-1/3" />
                </div>
              ))}
            </div>
          ) : aiExpertLogs.length === 0 ? (
            <div className="px-5 py-10 text-sm text-neutral-400">{t.dashboard.noChannelWorkerLogs}</div>
          ) : (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-96 overflow-y-auto">
              {aiExpertLogs.map(row => <AiExpertLogItem key={row.id} row={row} />)}
            </div>
          )}
        </div>

        {/* Copier Logs */}
        <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 min-w-0 overflow-hidden">
          <div className="px-4 sm:px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-teal-500" />
              <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{t.dashboard.copierLogs}</span>
              <button className="text-neutral-300 hover:text-neutral-500 dark:text-neutral-400">
                <Info className="w-3.5 h-3.5" />
              </button>
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
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{la.title}</p>
              <p className="text-xs text-neutral-400 dark:text-neutral-500">{la.subtitle}</p>
            </div>
          </div>
          <button
            onClick={() => setShowPlatformModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 dark:border-teal-600 text-teal-600 dark:text-teal-400 rounded-lg text-xs font-medium hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t.common.add}
          </button>
        </div>

        {brokerReconnectError ? (
          <div className="px-4 sm:px-5 py-2 text-sm text-error-600 dark:text-error-400 border-b border-neutral-100 dark:border-neutral-800">
            {brokerReconnectError}
          </div>
        ) : null}

        {brokersNeedingReconnect.length > 0 ? (
          <div className="px-4 sm:px-5 py-2 text-sm text-amber-700 dark:text-amber-300 border-b border-neutral-100 dark:border-neutral-800">
            {reconnectBannerText}
          </div>
        ) : null}

        <div className="overflow-x-auto">
        <div className="min-w-[52rem] lg:min-w-0">
        <div className="hidden lg:grid grid-cols-9 gap-2 px-4 sm:px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-medium text-neutral-400">
          <span>{la.colAccount}</span>
          <span>{la.colBroker}</span>
          <span>{la.colAccountType}</span>
          <span>{la.colBalance}</span>
          <span title={la.colPnlHint}>{la.colPnl}</span>
          <span>{la.colRoi}</span>
          <span>{la.colWinRate}</span>
          <span>{la.colDd}</span>
          <span className="text-right">{la.colStatus}</span>
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
            {linkedAccounts.map(account => (
              <LinkedAccountRow
                key={account.id}
                account={account}
                accountSummary={linkedAccountBalances[account.id]}
                performance={linkedAccountPerformance[account.id]}
                closedHistoryPnl={
                  hasMtTradeHistory ? (closedProfitByAccountId[account.id] ?? 0) : null
                }
                onToggleActive={is_active => { void toggleBrokerActive(account.id, is_active) }}
                toggleDisabled={togglingBrokerId === account.id}
                showReconnect={brokerCanReconnect(account)}
                isReconnecting={isBrokerReconnecting(account.id)}
                onReconnect={() => { void reconnectBroker(account.id) }}
              />
            ))}
          </div>
        )}
        </div>
        </div>
      </div>

      <AddAccountModal
        open={showPlatformModal}
        onClose={() => setShowPlatformModal(false)}
        onSelect={() => {
          setShowPlatformModal(false)
          navigate('/account-configuration')
        }}
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
      <p
        className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mb-1.5 sm:mb-2 inline-flex items-center gap-1"
        title={labelHint}
      >
        {label}
        {labelHint ? (
          <Info className="w-3.5 h-3.5 shrink-0 opacity-60" aria-hidden />
        ) : null}
      </p>
      <p className={`text-xl sm:text-2xl font-semibold mb-1 sm:mb-1.5 ${valueColor}`}>{value}</p>
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
  addLabel,
}: {
  label: string
  value: string
  sub?: string
  addTo?: string
  addLabel?: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-xs text-neutral-500 dark:text-neutral-400 min-w-0">{label}</p>
        {addTo ? (
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

function AiExpertLogItem({ row }: { row: AiExpertLogRow }) {
  const t = useT()
  const message = channelWorkerLogMessage(row, t.channelWorker)

  return (
    <div className="px-5 py-3">
      <p className="text-sm text-neutral-800 dark:text-neutral-100">{message}</p>
      <p className="text-[11px] text-neutral-400 mt-1">{new Date(row.created_at).toLocaleString()}</p>
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

function formatRoiPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

function LinkedAccountRow({
  account,
  accountSummary,
  performance,
  closedHistoryPnl,
  onToggleActive,
  toggleDisabled,
  showReconnect,
  isReconnecting,
  onReconnect,
}: {
  account: BrokerAccount
  accountSummary?: { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number }
  performance?: LinkedAccountPerformance
  /** Sum of closed-deal profit from MT history; null until trade history is loaded. */
  closedHistoryPnl?: number | null
  onToggleActive: (is_active: boolean) => void
  toggleDisabled?: boolean
  showReconnect?: boolean
  isReconnecting?: boolean
  onReconnect?: () => void
}) {
  const t = useT()
  const la = t.dashboard.linkedAccounts
  const { locale } = useLocale()
  const intlLocale = locale === 'en' ? undefined : locale
  const isDisconnected = !isBrokerSessionConnected(account)
  const statusClass = isDisconnected
    ? 'text-error-700 border-error-200 bg-error-50 dark:text-error-300 dark:border-error-800 dark:bg-error-950/50'
    : account.is_active
      ? 'text-teal-700 border-teal-200 bg-teal-50 dark:text-teal-300 dark:border-teal-800 dark:bg-teal-950/50'
      : 'text-neutral-600 border-neutral-200 bg-neutral-100 dark:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800/80'
  const balance = accountSummary?.balance ?? account.last_balance ?? null
  const equity = accountSummary?.equity ?? account.last_equity ?? null
  const accountCurrency = (accountSummary?.currency ?? account.last_currency ?? '').trim() || undefined
  const balanceText = formatMoneyWithCode(balance, accountCurrency, { locale: intlLocale })
  const hasBoth = balance != null && equity != null
  const pnl =
    closedHistoryPnl != null
      ? closedHistoryPnl
      : accountSummary?.open_pnl ?? (hasBoth ? equity! - balance! : 0)
  const pnlColor = pnl >= 0 ? 'text-teal-600' : 'text-error-600'
  const pnlFormatted = formatMoneyWithCode(Math.abs(pnl), accountCurrency, { locale: intlLocale, nullAsDash: false })
  const apiRaw = (accountSummary?.broker ?? '').trim()
  const fromApi = inferBrokerLabelFromServer(apiRaw) || apiRaw
  const server = resolveMtServerCandidate(account, accountSummary?.mt_server_hint)
  const fromServer = inferBrokerLabelFromServer(server) || (server?.trim() ?? '')
  const brokerText = fromApi || fromServer || '—'
  const accountType: LinkedAccountType | '—' =
    accountSummary?.account_type
    ?? resolveLinkedAccountType(
      undefined,
      resolveMtServerCandidate(account, accountSummary?.mt_server_hint),
    )
    ?? '—'
  const accountTypeClass =
    accountType === 'Demo'
      ? 'text-amber-700 dark:text-amber-300'
      : accountType === 'Live'
        ? 'text-teal-700 dark:text-teal-300'
        : 'text-neutral-900 dark:text-neutral-50'

  const accountLabel = account.label || la.unnamedAccount
  const platformLabel = (account.platform ?? '').trim().toUpperCase() || '—'
  const accountLogin = resolveAccountLogin(account)
  const platformLine = accountLogin ? `${platformLabel} • ${accountLogin}` : platformLabel
  const accountTypeLabel =
    accountType === 'Live'
      ? la.accountTypeLive
      : accountType === 'Demo'
        ? la.accountTypeDemo
        : accountType
  const roi = performance?.roi ?? null
  const winRate = performance?.winRate ?? null
  const maxDd = performance?.maxDrawdownPct ?? null
  const roiColor =
    roi == null ? 'text-neutral-900 dark:text-neutral-50' : roi > 0 ? 'text-teal-600' : roi < 0 ? 'text-error-600' : 'text-neutral-600 dark:text-neutral-400'
  const winRateColor =
    winRate == null ? 'text-neutral-900 dark:text-neutral-50' : winRate >= 50 ? 'text-teal-600' : 'text-neutral-900 dark:text-neutral-50'
  const ddColor =
    maxDd == null ? 'text-neutral-900 dark:text-neutral-50' : maxDd > 0 ? 'text-error-600' : 'text-neutral-600 dark:text-neutral-400'

  return (
    <div className="grid grid-cols-9 gap-2 px-4 sm:px-5 py-3 items-center hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 truncate">{accountLabel}</span>
        <span className="text-[11px] font-medium text-primary-600 uppercase tabular-nums">{platformLine}</span>
      </div>
      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{brokerText}</span>
      <span className={`text-sm font-semibold ${accountTypeClass}`}>{accountTypeLabel}</span>
      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{balanceText}</span>
      <span className={`text-sm font-semibold ${pnlColor}`}>
        {pnl >= 0 ? '+' : '-'}
        {pnlFormatted}
      </span>
      <span className={`text-sm font-semibold tabular-nums ${roiColor}`}>{formatRoiPct(roi)}</span>
      <span className={`text-sm font-semibold tabular-nums ${winRateColor}`}>{formatPerformancePct(winRate, 0)}</span>
      <span className={`text-sm font-semibold tabular-nums ${ddColor}`}>{formatPerformancePct(maxDd)}</span>
      <div className="flex justify-end items-center gap-2">
        {showReconnect ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={isReconnecting}
            onClick={onReconnect}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {la.reconnect}
          </Button>
        ) : null}
        <Toggle
          checked={account.is_active}
          onChange={onToggleActive}
          disabled={toggleDisabled}
        />
        <span className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-xs font-semibold ${statusClass}`}>
          {brokerConnectionStatusLabel(account, la)}
        </span>
      </div>
    </div>
  )
}
