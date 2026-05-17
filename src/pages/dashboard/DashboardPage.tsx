import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Clock, ChevronRight, Info, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import type { BrokerAccount, Signal, Trade } from '../../types/database'
import {
  inferBrokerLabelFromServer,
  resolveLinkedAccountType,
  resolveMtServerCandidate,
  type LinkedAccountType,
} from '../../lib/brokerFromServer'
import { AddAccountModal } from '../../components/ui/AddAccountModal'
import { Toggle } from '../../components/ui/Toggle'
import { metatraderApi, type MtTrade } from '../../lib/metatraderapi'
import {
  computeLinkedAccountPerformanceMap,
  countClosedTradeOutcomesInRange,
  isTradeableClosedRow,
  netClosedLegProfit,
  sumTradeableClosedProfitInRange,
  type LinkedAccountPerformance,
  type TradeStatsRow,
} from '../../lib/dashboardTradeStats'
import {
  buildCopierLogSymbolLabels,
  buildSignalSymbolLookup,
} from '../../lib/copierLogDisplay'
import { channelWorkerLogMessage } from '../../lib/channelWorkerLogMessage'
import {
  buildAccountGrowthSeries,
  buildTradeVolume7Day,
  resolveDashboardChartTrades,
  type DashboardChartTrade,
} from '../../lib/dashboardCharts'
import { AccountGrowthChart } from '../../components/dashboard/AccountGrowthChart'
import { TradeVolumeChart } from '../../components/dashboard/TradeVolumeChart'
import { useDashboardRealtime } from '../../hooks/useDashboardRealtime'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'

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
  return d.toISOString().slice(0, 19)
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

/** Keep live MT equity/open stats when a quiet DB refresh would overwrite them. */
function mergeBrokerBalances(
  fromDb: Record<string, BrokerBalanceSnapshot>,
  prev: Record<string, BrokerBalanceSnapshot>,
  sticky: Record<string, { open_pnl?: number; open_trades?: number }>,
): Record<string, BrokerBalanceSnapshot> {
  const out: Record<string, BrokerBalanceSnapshot> = { ...fromDb }
  for (const id of new Set([...Object.keys(fromDb), ...Object.keys(prev)])) {
    const db = fromDb[id]
    const old = prev[id]
    const st = sticky[id]
    if (!db && !old) continue
    out[id] = {
      ...(db ?? {}),
      balance: old?.balance ?? db?.balance,
      equity: old?.equity ?? db?.equity,
      currency: db?.currency ?? old?.currency,
      broker: db?.broker ?? old?.broker,
      mt_server_hint: db?.mt_server_hint ?? old?.mt_server_hint,
      account_type: db?.account_type ?? old?.account_type,
      open_pnl: st?.open_pnl ?? old?.open_pnl ?? db?.open_pnl,
      open_trades: st?.open_trades ?? old?.open_trades ?? db?.open_trades,
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

const DASHBOARD_CACHE_VERSION = 'dashboard_cache_v9'
const DASHBOARD_CACHE_LEGACY_KEYS = ['dashboard_cache_v8', 'dashboard_cache_v7'] as const
const DASHBOARD_ACTIVE_USER_KEY = 'dashboard_cache_active_user_id'

const DEFAULT_DASHBOARD_STATS: DashboardStats = {
  accounts: 0,
  portfolioValue: 0,
  totalEquity: 0,
  tradesTaken: 0,
  tradesWon: 0,
  tradesLost: 0,
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

function readBootstrapDashboardCache(): DashboardCachePayload | null {
  if (typeof sessionStorage === 'undefined') return null
  const userId = sessionStorage.getItem(DASHBOARD_ACTIVE_USER_KEY)
  if (!userId) return null
  return readDashboardCache(userId)
}

/** Avoid flashing DB/empty snapshots over live MT or session-cached figures. */
function mergeDashboardStats(
  prev: DashboardStats,
  next: DashboardStats,
  authoritative: boolean,
  opts?: { mtHasClosedTrades?: boolean },
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
      }
    }
    return { ...prev, ...next }
  }
  const keepNum = (p: number, n: number) => (Number.isFinite(n) && !(n === 0 && p !== 0) ? n : p)
  const keepStr = (p: string, n: string) => (n === '—' && p !== '—' ? p : n)
  return {
    ...next,
    totalEquity: keepNum(prev.totalEquity, next.totalEquity),
    portfolioValue: keepNum(prev.portfolioValue, next.portfolioValue),
    openPnl: keepNum(prev.openPnl, next.openPnl),
    openPositions: keepNum(prev.openPositions, next.openPositions),
    openTrades: keepNum(prev.openTrades, next.openTrades),
    todayProfit: keepNum(prev.todayProfit, next.todayProfit),
    yesterdayProfit: keepNum(prev.yesterdayProfit, next.yesterdayProfit),
    tradesTaken: keepNum(prev.tradesTaken, next.tradesTaken),
    tradesWon: keepNum(prev.tradesWon, next.tradesWon),
    tradesLost: keepNum(prev.tradesLost, next.tradesLost),
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
) {
  if (!balances) return
  for (const [id, v] of Object.entries(balances)) {
    if (!v) continue
    target[id] = {
      open_pnl: typeof v.open_pnl === 'number' ? v.open_pnl : target[id]?.open_pnl,
      open_trades: typeof v.open_trades === 'number' ? v.open_trades : target[id]?.open_trades,
    }
  }
}

export function DashboardPage() {
  const t = useT()
  const { user } = useAuth()
  const navigate = useNavigate()
  const bootCache = useMemo(() => readBootstrapDashboardCache(), [])
  const [stats, setStats] = useState<DashboardStats>(() => bootCache?.stats ?? DEFAULT_DASHBOARD_STATS)
  const [copierLogs, setCopierLogs] = useState<Signal[]>(() => bootCache?.copierLogs ?? [])
  const [copierLogSymbols, setCopierLogSymbols] = useState<Record<string, string>>(
    () => bootCache?.copierLogSymbols ?? {},
  )
  const [channelDisplayNames, setChannelDisplayNames] = useState<Record<string, string>>(
    () => bootCache?.channelDisplayNames ?? {},
  )
  const [aiExpertLogs, setAiExpertLogs] = useState<AiExpertLogRow[]>(() => bootCache?.aiExpertLogs ?? [])
  const [linkedAccounts, setLinkedAccounts] = useState<BrokerAccount[]>(() => bootCache?.linkedAccounts ?? [])
  const [linkedAccountBalances, setLinkedAccountBalances] = useState<Record<string, BrokerBalanceSnapshot>>(
    () => bootCache?.linkedAccountBalances ?? {},
  )
  const [chartTrades, setChartTrades] = useState<DashboardChartTrade[]>(() => bootCache?.chartTrades ?? [])
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [togglingBrokerId, setTogglingBrokerId] = useState<string | null>(null)
  /** Background MT/broker poll — DB changes use Supabase Realtime instead. */
  const MT_LIVE_REFRESH_MS = 45_000
  const BROKER_SUMMARY_REFRESH_MS = 30_000
  const MT_TRADES_REFRESH_MS = 30_000
  const lastBrokerRefreshRef = useRef<number>(0)
  const lastMtTradesRefreshRef = useRef<number>(0)
  /** Ignore stale responses when a newer *fresh* loadDashboard run started. */
  const loadGenerationRef = useRef(0)
  const dashboardReadyRef = useRef(Boolean(bootCache?.stats))
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
    seedLiveBrokerStateFromBalances(bootCache.linkedAccountBalances, liveBrokerStateRef.current)
  }
  const hydratedUserRef = useRef<string | null>(bootCache ? sessionStorage.getItem(DASHBOARD_ACTIVE_USER_KEY) : null)
  const statsRef = useRef(stats)
  useEffect(() => {
    statsRef.current = stats
  }, [stats])

  if (user?.id && hydratedUserRef.current !== user.id) {
    hydratedUserRef.current = user.id
    const cached = readDashboardCache(user.id)
    if (cached?.stats) {
      setStats(cached.stats)
      setCopierLogs(cached.copierLogs ?? [])
      setCopierLogSymbols(cached.copierLogSymbols ?? {})
      setChannelDisplayNames(cached.channelDisplayNames ?? {})
      setLinkedAccounts(cached.linkedAccounts ?? [])
      const balances = cached.linkedAccountBalances ?? {}
      linkedBalancesRef.current = balances
      setLinkedAccountBalances(balances)
      if (cached.chartTrades?.length) setChartTrades(cached.chartTrades)
      if (cached.aiExpertLogs?.length) setAiExpertLogs(cached.aiExpertLogs)
      if (cached.mtTrades?.length) mtTradesRef.current = cached.mtTrades
      seedLiveBrokerStateFromBalances(balances, liveBrokerStateRef.current)
    }
    dashboardReadyRef.current = Boolean(cached?.stats)
  }
  const formatMoney = (value: number | null | undefined) =>
    `$${(Number.isFinite(value as number) ? Number(value) : 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const tradeVolume7Day = useMemo(
    () => buildTradeVolume7Day(chartTrades),
    [chartTrades],
  )

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

  const accountGrowth = useMemo(
    () => buildAccountGrowthSeries(linkedAccounts, chartTrades, equityByAccountId),
    [linkedAccounts, chartTrades, equityByAccountId],
  )

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
      for (const t of chartTrades) {
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
  }, [linkedAccounts, chartTrades, equityByAccountId])

  const formatVsYesterdayMoney = (todayValue: number | null | undefined, yesterdayValue: number | null | undefined) => {
    if (yesterdayValue == null) return ''
    const t = Number.isFinite(todayValue as number) ? Number(todayValue) : 0
    const y = Number.isFinite(yesterdayValue as number) ? Number(yesterdayValue) : 0
    const delta = t - y
    return `vs yesterday: ${formatMoney(yesterdayValue)} (${delta >= 0 ? '+' : ''}${formatMoney(delta)})`
  }

  const loadDashboard = async (opts: { fresh?: boolean; syncLive?: boolean } = {}) => {
    const { fresh = false, syncLive = fresh } = opts
    const generation = fresh ? ++loadGenerationRef.current : loadGenerationRef.current
    try {
    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const tomorrowStart = new Date(todayStart)
    tomorrowStart.setDate(tomorrowStart.getDate() + 1)
    const yesterdayStart = new Date(todayStart)
    yesterdayStart.setDate(yesterdayStart.getDate() - 1)

    const [brokerRes, channelsRes, tradesRes, todaySignalsRes, yesterdaySignalsRes, logsRes, allSignalsRes, channelsMetaRes, aiLogsRes] = await Promise.all([
      supabase.from('broker_accounts').select('*').eq('user_id', user!.id),
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
          signals ( raw_message, parsed_data )
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
    const isInRange = (dateString: string | null | undefined, start: Date, end: Date) => {
      if (!dateString) return false
      const ts = new Date(dateString).getTime()
      return Number.isFinite(ts) && ts >= start.getTime() && ts < end.getTime()
    }

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
    const closedTodayForStats = (closedAt: string | null) => isInRange(closedAt, todayStart, tomorrowStart)
    const closedYesterdayForStats = (closedAt: string | null) => isInRange(closedAt, yesterdayStart, todayStart)
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

    const todayProfit = sumTradeableClosedProfitInRange(sourceTrades, closedTodayForStats)
    const yesterdayProfit = sumTradeableClosedProfitInRange(sourceTrades, closedYesterdayForStats)
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
    const brokerAccounts = (brokerRes.data ?? []) as BrokerAccount[]
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
            open_pnl: sticky?.open_pnl ?? cachedOpenPnl,
            open_trades: sticky?.open_trades,
          },
        ]
      }),
    ) as Record<string, BrokerBalanceSnapshot>
    const mergedBalances = mergeBrokerBalances(
      balanceMap,
      linkedBalancesRef.current,
      liveBrokerStateRef.current,
    )
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
      const acct = mergedBalances[account.id]
      return sum + (acct?.open_pnl ?? 0)
    }, 0)
    const totalLiveOpenTradesFromSummary = brokerAccounts.reduce((sum, account) => {
      const acct = mergedBalances[account.id]
      return sum + (acct?.open_trades ?? 0)
    }, 0)
    const hasAnyBrokerOpenPnl = brokerAccounts.some(account => mergedBalances[account.id]?.open_pnl != null)
    const hasAnyBrokerOpenTradesFromSummary = brokerAccounts.some(account => mergedBalances[account.id]?.open_trades != null)

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

    const mergedAfterDb = mergeDashboardStats(statsRef.current, nextStats, useMtTrades)
    statsRef.current = mergedAfterDb
    setStats(mergedAfterDb)
    setCopierLogs(logs)
    setCopierLogSymbols(logSymbols)
    setChannelDisplayNames(channelNames)
    setLinkedAccounts(brokerAccounts)
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
      if (fresh && generation === loadGenerationRef.current) {
        dashboardReadyRef.current = true
      }
    }
  }

  refreshQuietRef.current = () => {
    if (!dashboardReadyRef.current) return
    void loadDashboard({ fresh: false, syncLive: false })
  }

  useDashboardRealtime(user?.id, () => refreshQuietRef.current())

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
        void loadDashboard({ fresh: false, syncLive: true })
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

    const historyFrom = new Date()
    historyFrom.setDate(historyFrom.getDate() - 14)
    let trades: MtTrade[]
    try {
      const res = await metatraderApi.trades({
        scope: 'all',
        historyFrom: formatMtApiDateTime(historyFrom),
        historyTo: formatMtApiDateTime(new Date()),
      })
      trades = res.trades ?? []
    } catch {
      return
    }
    mtTradesRef.current = trades
    const chartNext = resolveDashboardChartTrades(trades, [])
    setChartTrades(prev => preferChartTrades(prev, chartNext))
    if (trades.length === 0) return

    const today0 = new Date()
    today0.setHours(0, 0, 0, 0)
    const tomorrow0 = new Date(today0)
    tomorrow0.setDate(tomorrow0.getDate() + 1)
    const yesterday0 = new Date(today0)
    yesterday0.setDate(yesterday0.getDate() - 1)
    const inRange = (iso: string | null, start: Date, end: Date) => {
      if (!iso) return false
      const ts = new Date(iso).getTime()
      return Number.isFinite(ts) && ts >= start.getTime() && ts < end.getTime()
    }

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
    const tradeRows: TradeStatsRow[] = trades.map(t => ({
      status: t.status,
      profit: t.profit,
      closed_at: t.closed_at,
      symbol: t.symbol,
      lot_size: t.lot_size,
      direction: t.direction,
      type: t.type,
      swap: t.swap,
      commission: t.commission,
    }))
    const closedOutcomesToday = countClosedTradeOutcomesInRange(tradeRows, closedTodayForStats)
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
      totalVolume: today.reduce((sum, t) => sum + (t.lot_size ?? 0), 0),
      yesterdayTotalVolume: yesterday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0),
      bestTradeProfit: posTodayLeg.length ? Math.max(...posTodayLeg) : 0,
      yesterdayBestTradeProfit: posYestLeg.length ? Math.max(...posYestLeg) : 0,
      worstTradeProfit: negTodayLeg.length ? Math.min(...negTodayLeg) : 0,
      yesterdayWorstTradeProfit: negYestLeg.length ? Math.min(...negYestLeg) : 0,
      todayProfit: sumTradeableClosedProfitInRange(tradeRows, closedTodayForStats),
      yesterdayProfit: sumTradeableClosedProfitInRange(tradeRows, closedYesterdayForStats),
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

    const results = await Promise.all(
      mtBrokers.map(async (b) => {
        try {
          const { summary, open_positions, performance_baseline_balance } = await metatraderApi.summary(b.id)
          return {
            id: b.id,
            summary,
            open_positions,
            performance_baseline_balance: performance_baseline_balance ?? null,
            error: null as Error | null,
          }
        } catch (err) {
          return {
            id: b.id,
            summary: null,
            open_positions: null as number | null,
            performance_baseline_balance: null as number | null,
            error: err instanceof Error ? err : new Error('summary failed'),
          }
        }
      }),
    )

    const successes = results.filter(r => r.summary)
    if (successes.length === 0) return

    const prevBalances = balanceSeed ?? linkedAccountBalances
    const nextBalances = { ...prevBalances }
    for (const r of successes) {
      const s = r.summary!
      const broker = sourceAccounts.find(b => b.id === r.id)
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
      const liveOpenTrades = typeof r.open_positions === 'number'
        ? r.open_positions
        : nextBalances[r.id]?.open_trades
      nextBalances[r.id] = {
        ...(nextBalances[r.id] ?? {}),
        balance: nextBalance,
        equity: nextEquity,
        currency: s.currency ?? nextBalances[r.id]?.currency,
        account_type: accountType ?? nextBalances[r.id]?.account_type,
        open_pnl: liveProfit,
        open_trades: liveOpenTrades,
      }
      // Persist live values across throttled refreshes / loadDashboard ticks.
      liveBrokerStateRef.current[r.id] = {
        open_pnl: typeof liveProfit === 'number' ? liveProfit : liveBrokerStateRef.current[r.id]?.open_pnl,
        open_trades: typeof liveOpenTrades === 'number' ? liveOpenTrades : liveBrokerStateRef.current[r.id]?.open_trades,
      }
    }
    linkedBalancesRef.current = nextBalances
    setLinkedAccountBalances(nextBalances)

    const sawOpenPosCount = successes.some(r => typeof r.open_positions === 'number')
    const mtOpenTotal = mtBrokers.reduce((sum, b) => {
      const v = nextBalances[b.id]?.open_trades
      return sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    }, 0)

    // Recompute portfolio value (pure balance), equity, and open PnL from the freshest snapshot.
    setStats(prev => {
      let portfolioValue = 0
      let totalEquity = 0
      let openPnl = 0
      let sawLivePnl = false
      for (const account of sourceAccounts) {
        const live = successes.find(r => r.id === account.id)?.summary
        const equity = live?.equity ?? account.last_equity ?? account.last_balance ?? 0
        const balance = live?.balance ?? account.last_balance ?? 0
        portfolioValue += balance || 0
        totalEquity += equity || balance || 0
        if (live) {
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
      const next = {
        ...prev,
        portfolioValue,
        totalEquity,
        openPnl: sawLivePnl ? openPnl : prev.openPnl,
        totalProfitLoss,
        ...(sawOpenPosCount ? { openPositions: mtOpenTotal, openTrades: mtOpenTotal } : {}),
      }
      statsRef.current = next
      return next
    })

    // Persist the freshly-fetched values back to the broker row state so the
    // session cache (and any subsequent re-render) keeps the live numbers.
    setLinkedAccounts(prev =>
      prev.map(b => {
        const row = successes.find(r => r.id === b.id)
        const live = row?.summary
        if (!live) return b
        const nextBaseline =
          row.performance_baseline_balance != null && Number.isFinite(Number(row.performance_baseline_balance))
            ? Number(row.performance_baseline_balance)
            : b.performance_baseline_balance
        return {
          ...b,
          last_balance: live.balance ?? b.last_balance ?? null,
          last_equity: live.equity ?? b.last_equity ?? null,
          last_currency: live.currency ?? b.last_currency ?? null,
          last_synced_at: new Date().toISOString(),
          connection_status: 'connected',
          performance_baseline_balance: nextBaseline ?? b.performance_baseline_balance,
        }
      }),
    )
  }

  const toggleBrokerActive = async (id: string, is_active: boolean) => {
    if (!user) return
    setLinkedAccounts(prev => {
      const next = prev.map(a => (a.id === id ? { ...a, is_active } : a))
      const activeCount = next.filter(a => a.is_active).length
      setStats(s => ({
        ...s,
        accounts: activeCount,
        copierHealth: activeCount > 0 ? (s.copierHealth === 'Offline' ? 'Stable' : s.copierHealth) : 'Offline',
      }))
      return next
    })
    setTogglingBrokerId(id)
    const { error: upErr } = await supabase
      .from('broker_accounts')
      .update({ is_active })
      .eq('id', id)
      .eq('user_id', user.id)
    setTogglingBrokerId(null)
    if (upErr) {
      setLinkedAccounts(prev => {
        const next = prev.map(a => (a.id === id ? { ...a, is_active: !is_active } : a))
        const activeCount = next.filter(a => a.is_active).length
        setStats(s => ({
          ...s,
          accounts: activeCount,
          copierHealth: activeCount > 0 ? (s.copierHealth === 'Offline' ? 'Stable' : s.copierHealth) : 'Offline',
        }))
        return next
      })
    }
  }

  const chartsEmpty = chartTrades.length === 0 && linkedAccounts.length === 0

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6 lg:p-8 max-w-[1600px] mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-neutral-900 dark:text-neutral-50">{t.dashboard.title}</h1>
        
      </div>

      {/* Stats bar */}
      <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 mb-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-neutral-100 dark:divide-neutral-800">
          <StatBlock
            label={t.dashboard.totalBalance}
            value={`$${stats.totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            sub={interpolate(t.dashboard.acrossAccounts, { count: stats.accounts })}
            subColor="text-neutral-400"
          />
          <StatBlock
            label={t.dashboard.todaysProfit}
            value={formatMoney(stats.todayProfit)}
            sub={formatVsYesterdayMoney(stats.todayProfit, stats.yesterdayProfit)}
            valueColor={
              stats.todayProfit > 0
                ? 'text-teal-600'
                : stats.todayProfit < 0
                  ? 'text-error-600'
                  : 'text-neutral-900 dark:text-neutral-50'
            }
            subColor={stats.todayProfit >= 0 ? 'text-neutral-400' : 'text-error-500'}
          />
          <StatBlock
            label={t.dashboard.tradesTakenToday}
            value={String(stats.tradesTaken)}
            sub={
              stats.tradesTaken === 0 ? (
                t.dashboard.noClosedTradesToday
              ) : (
                <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  <span className="text-teal-600 dark:text-teal-500">
                    {interpolate(t.common.won, { count: stats.tradesWon })}
                  </span>
                  <span className="text-neutral-300 dark:text-neutral-600">•</span>
                  <span className="text-error-500">
                    {interpolate(t.common.lost, { count: stats.tradesLost })}
                  </span>
                  {stats.tradesTaken > stats.tradesWon + stats.tradesLost ? (
                    <>
                      <span className="text-neutral-300 dark:text-neutral-600">•</span>
                      <span className="text-neutral-500 dark:text-neutral-400">
                        {interpolate(t.common.breakeven, {
                          count: stats.tradesTaken - stats.tradesWon - stats.tradesLost,
                        })}
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
            value={`$${stats.openPnl.toFixed(2)}`}
            sub={t.dashboard.acrossAllAccounts}
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
            sub={t.dashboard.connectedTelegramChannels}
            addTo="/copier-engine"
            addLabel={t.dashboard.manageChannels}
          />
          <OverviewStat
            label={t.dashboard.openTrades}
            value={String(stats.openTrades)}
            sub={t.dashboard.activeBrokerPositions}
          />
          <OverviewStat
            label={t.dashboard.tradingAccountsConnected}
            value={String(stats.accounts)}
            sub={interpolate(t.dashboard.acrossAccounts, { count: stats.accounts })}
            addTo="/account-configuration"
            addLabel={t.dashboard.addOrManageAccounts}
          />
          <OverviewStat
            label={t.dashboard.tradesCopiedToday}
            value={String(stats.tradesCopiedToday)}
            sub={t.dashboard.executedFromSignals}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <TradeVolumeChart data={tradeVolume7Day} loading={chartsEmpty} />
        <AccountGrowthChart
          data={accountGrowth.data}
          series={accountGrowth.series}
          loading={chartsEmpty}
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
              onClick={() => navigate('/copier-engine')}
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
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Linked Accounts</p>
              <p className="text-xs text-neutral-400 dark:text-neutral-500">Connected broker accounts used by copier</p>
            </div>
          </div>
          <button
            onClick={() => setShowPlatformModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 dark:border-teal-600 text-teal-600 dark:text-teal-400 rounded-lg text-xs font-medium hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>

        <div className="overflow-x-auto">
        <div className="min-w-[52rem] lg:min-w-0">
        <div className="hidden lg:grid grid-cols-9 gap-2 px-4 sm:px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-medium text-neutral-400">
          <span>Account</span>
          <span>Broker</span>
          <span>Account Type</span>
          <span>Balance</span>
          <span>PnL</span>
          <span>ROI</span>
          <span>WinRate</span>
          <span>DD</span>
          <span className="text-right">Status</span>
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
          <div className="px-5 py-8 text-sm text-neutral-400">No linked accounts yet.</div>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800"> 
            {linkedAccounts.map(account => (
              <LinkedAccountRow
                key={account.id}
                account={account}
                accountSummary={linkedAccountBalances[account.id]}
                performance={linkedAccountPerformance[account.id]}
                onToggleActive={is_active => { void toggleBrokerActive(account.id, is_active) }}
                toggleDisabled={togglingBrokerId === account.id}
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
          navigate('/account-config')
        }}
      />
    </div>
  )
}

function StatBlock({ label, value, sub, subColor, valueColor = 'text-neutral-900 dark:text-neutral-50' }: {
  label: string
  value: string
  sub: ReactNode
  subColor: string
  valueColor?: string
}) {
  return (
    <div className="px-4 py-4 sm:px-6 sm:py-5">
      <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mb-1.5 sm:mb-2">{label}</p>
      <p className={`text-xl sm:text-3xl font-semibold mb-1 sm:mb-1.5 ${valueColor}`}>{value}</p>
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
  const message = channelWorkerLogMessage(row)

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
  onToggleActive,
  toggleDisabled,
}: {
  account: BrokerAccount
  accountSummary?: { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number }
  performance?: LinkedAccountPerformance
  onToggleActive: (is_active: boolean) => void
  toggleDisabled?: boolean
}) {
  const statusClass = account.is_active
    ? 'text-teal-700 border-teal-200 bg-teal-50 dark:text-teal-300 dark:border-teal-800 dark:bg-teal-950/50'
    : 'text-neutral-600 border-neutral-200 bg-neutral-100 dark:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800/80'
  const balance = accountSummary?.balance ?? account.last_balance ?? null
  const equity = accountSummary?.equity ?? account.last_equity ?? null
  const currencyRaw = (accountSummary?.currency ?? account.last_currency ?? '').trim()
  const currencyPrefix = !currencyRaw || currencyRaw.toUpperCase() === 'USD' ? '$' : `${currencyRaw} `
  const balanceText = balance != null
    ? `${currencyPrefix}${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'
  const hasBoth = balance != null && equity != null
  const pnl = accountSummary?.open_pnl ?? (hasBoth ? (equity! - balance!) : 0)
  const pnlColor = pnl >= 0 ? 'text-teal-600' : 'text-error-600'
  const pnlText = `${currencyPrefix}${Math.abs(pnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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

  const accountLabel = account.label || 'Unnamed account'
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
        <span className="text-[11px] font-medium text-primary-600 uppercase">{account.platform}</span>
      </div>
      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{brokerText}</span>
      <span className={`text-sm font-semibold ${accountTypeClass}`}>{accountType}</span>
      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{balanceText}</span>
      <span className={`text-sm font-semibold ${pnlColor}`}>{pnl >= 0 ? '+' : '-'}{pnlText}</span>
      <span className={`text-sm font-semibold tabular-nums ${roiColor}`}>{formatRoiPct(roi)}</span>
      <span className={`text-sm font-semibold tabular-nums ${winRateColor}`}>{formatPerformancePct(winRate, 0)}</span>
      <span className={`text-sm font-semibold tabular-nums ${ddColor}`}>{formatPerformancePct(maxDd)}</span>
      <div className="flex justify-end items-center gap-2">
        <Toggle
          checked={account.is_active}
          onChange={onToggleActive}
          disabled={toggleDisabled}
        />
        <span className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-xs font-semibold ${statusClass}`}>
          {account.is_active ? 'Active' : 'Paused'}
        </span>
      </div>
    </div>
  )
}
