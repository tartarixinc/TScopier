import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Clock, ChevronRight, Info, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import type { BrokerAccount, Signal, Trade } from '../../types/database'
import { inferBrokerLabelFromServer, resolveMtServerCandidate } from '../../lib/brokerFromServer'
import { AddAccountModal } from '../../components/ui/AddAccountModal'
import { metatraderApi, type MtTrade } from '../../lib/metatraderapi'
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

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [stats, setStats] = useState<DashboardStats>({
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
  })
  const [copierLogs, setCopierLogs] = useState<Signal[]>([])
  const [copierLogSymbols, setCopierLogSymbols] = useState<Record<string, string>>({})
  const [channelDisplayNames, setChannelDisplayNames] = useState<Record<string, string>>({})
  const [aiExpertLogs, setAiExpertLogs] = useState<AiExpertLogRow[]>([])
  const [linkedAccounts, setLinkedAccounts] = useState<BrokerAccount[]>([])
  const [linkedAccountBalances, setLinkedAccountBalances] = useState<Record<string, { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number; open_trades?: number }>>({})
  const [chartTrades, setChartTrades] = useState<DashboardChartTrade[]>([])
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [loading, setLoading] = useState(true)
  const AUTO_REFRESH_MS = 15000
  const BROKER_SUMMARY_REFRESH_MS = 30000
  const MT_TRADES_REFRESH_MS = 30000
  const DASHBOARD_CACHE_PREFIX = 'dashboard_cache_v6'
  const lastBrokerRefreshRef = useRef<number>(0)
  const lastMtTradesRefreshRef = useRef<number>(0)
  /** Last successful MT trades response, kept across renders so stats survive throttled refresh windows. */
  const mtTradesRef = useRef<MtTrade[] | null>(null)
  /**
   * Last known MT live values per broker id, kept across `loadDashboard` calls so
   * the auto-refresh tick (15s) doesn't bounce stats back to DB defaults while
   * `refreshBrokerSummaries` is between throttled runs (30s). Without this the
   * Active Trades stat fluctuates 0/1 between ticks.
   */
  const liveBrokerStateRef = useRef<Record<string, { open_pnl?: number; open_trades?: number }>>({})
  const formatMoney = (value: number | null | undefined) =>
    `$${(Number.isFinite(value as number) ? Number(value) : 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const tradeVolume7Day = useMemo(
    () => buildTradeVolume7Day(chartTrades),
    [chartTrades],
  )

  const accountGrowth = useMemo(() => {
    const equityByAccountId: Record<string, number> = {}
    for (const account of linkedAccounts) {
      const live = linkedAccountBalances[account.id]
      const eq = live?.equity ?? live?.balance ?? account.last_equity ?? account.last_balance
      if (eq != null && Number.isFinite(Number(eq))) {
        equityByAccountId[account.id] = Number(eq)
      }
    }
    return buildAccountGrowthSeries(linkedAccounts, chartTrades, equityByAccountId)
  }, [linkedAccounts, linkedAccountBalances, chartTrades])

  const formatVsYesterdayMoney = (todayValue: number | null | undefined, yesterdayValue: number | null | undefined) => {
    if (yesterdayValue == null) return ''
    const t = Number.isFinite(todayValue as number) ? Number(todayValue) : 0
    const y = Number.isFinite(yesterdayValue as number) ? Number(yesterdayValue) : 0
    const delta = t - y
    return `vs yesterday: ${formatMoney(yesterdayValue)} (${delta >= 0 ? '+' : ''}${formatMoney(delta)})`
  }

  useEffect(() => {
    if (!user) return
    const cacheKey = `${DASHBOARD_CACHE_PREFIX}:${user.id}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as {
          stats?: DashboardStats
          copierLogs?: Signal[]
          copierLogSymbols?: Record<string, string>
          channelDisplayNames?: Record<string, string>
          linkedAccounts?: BrokerAccount[]
          linkedAccountBalances?: Record<string, { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number; open_trades?: number }>
        }
        if (parsed.stats) {
          setStats(prev => ({ ...prev, ...parsed.stats }))
        }
        if (parsed.copierLogs) setCopierLogs(parsed.copierLogs)
        if (parsed.copierLogSymbols) setCopierLogSymbols(parsed.copierLogSymbols)
        if (parsed.channelDisplayNames) setChannelDisplayNames(parsed.channelDisplayNames)
        if (parsed.linkedAccounts) setLinkedAccounts(parsed.linkedAccounts)
        if (parsed.linkedAccountBalances) {
          setLinkedAccountBalances(parsed.linkedAccountBalances)
          // Seed sticky-live cache so the very next loadDashboard doesn't flicker
          // back to DB-derived defaults before the first /AccountSummary refresh.
          for (const [id, v] of Object.entries(parsed.linkedAccountBalances)) {
            if (!v) continue
            liveBrokerStateRef.current[id] = {
              open_pnl: typeof v.open_pnl === 'number' ? v.open_pnl : liveBrokerStateRef.current[id]?.open_pnl,
              open_trades: typeof v.open_trades === 'number' ? v.open_trades : liveBrokerStateRef.current[id]?.open_trades,
            }
          }
        }
        setLoading(false)
        void loadDashboard({ silent: true })
        return
      } catch {
        // Ignore malformed cache and do a normal load below.
      }
    }
    void loadDashboard()
  }, [user])

  useEffect(() => {
    if (!user) return

    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      // Reduce unnecessary API calls when tab is not visible.
      if (document.visibilityState !== 'visible') return
      await loadDashboard({ silent: true })
    }

    const interval = window.setInterval(() => {
      void tick()
    }, AUTO_REFRESH_MS)

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void tick()
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user])

  const loadDashboard = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true)
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
        .limit(12),
    ])

    const allTrades = (tradesRes.data ?? []) as Trade[]
    const openTrades = allTrades.filter(t => t.status === 'open')
    const closedTrades = allTrades.filter(t => t.status === 'closed')
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
    const useMtTrades = Array.isArray(mtTrades) && mtTrades.length > 0
    type WindowedTrade = {
      symbol: string
      profit: number | null
      lot_size: number
      status: 'open' | 'closed'
      opened_at: string | null
      closed_at: string | null
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
        }))
      : []
    const sourceTrades: WindowedTrade[] = useMtTrades ? mtWindowed : dbWindowed

    const tradesToday = sourceTrades.filter(t => isInRange(t.opened_at, todayStart, tomorrowStart))
    const tradesYesterday = sourceTrades.filter(t => isInRange(t.opened_at, yesterdayStart, todayStart))
    const totalVolume = tradesToday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0)
    const yesterdayTotalVolume = tradesYesterday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0)

    const closedToday = sourceTrades.filter(t => t.status === 'closed' && isInRange(t.closed_at, todayStart, tomorrowStart))
    const closedYesterdayWindow = sourceTrades.filter(
      t => t.status === 'closed' && isInRange(t.closed_at, yesterdayStart, todayStart),
    )
    const positivePnls = (rows: WindowedTrade[]) =>
      rows.map(t => t.profit).filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0)
    const negativePnls = (rows: WindowedTrade[]) =>
      rows.map(t => t.profit).filter((p): p is number => typeof p === 'number' && Number.isFinite(p) && p < 0)
    const posToday = positivePnls(closedToday)
    const negToday = negativePnls(closedToday)
    const posYest = positivePnls(closedYesterdayWindow)
    const negYest = negativePnls(closedYesterdayWindow)
    const bestTradeProfit = posToday.length ? Math.max(...posToday) : 0
    const yesterdayBestTradeProfit = posYest.length ? Math.max(...posYest) : 0
    const worstTradeProfit = negToday.length ? Math.min(...negToday) : 0
    const yesterdayWorstTradeProfit = negYest.length ? Math.min(...negYest) : 0

    const todayProfit = closedToday.reduce((sum, t) => sum + (t.profit ?? 0), 0)
    const yesterdayProfit = closedYesterdayWindow.reduce((sum, t) => sum + (t.profit ?? 0), 0)
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
    const won = closedTrades.filter(t => (t.profit ?? 0) > 0).length
    const lost = closedTrades.filter(t => (t.profit ?? 0) < 0).length
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
            open_pnl: sticky?.open_pnl ?? cachedOpenPnl,
            open_trades: sticky?.open_trades,
          },
        ]
      }),
    ) as Record<string, { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number; open_trades?: number }>
    /** Lifetime-style total vs baseline balance at link (sum of equity − baseline per account). */
    const yesterdayTotalProfitLoss: number | null = null
    const totalProfitLoss = aggregateTotalProfitFromBaselines(brokerAccounts, (account) => {
      const m = balanceMap[account.id]
      return Number(m?.equity ?? m?.balance ?? account.last_equity ?? account.last_balance ?? Number.NaN)
    })
    const totalPortfolioValue = brokerAccounts.reduce((sum, account) => {
      const acct = balanceMap[account.id]
      return sum + (acct?.balance ?? 0)
    }, 0)
    const totalEquityValue = brokerAccounts.reduce((sum, account) => {
      const acct = balanceMap[account.id]
      return sum + (acct?.equity ?? acct?.balance ?? 0)
    }, 0)
    const totalLiveOpenPnl = brokerAccounts.reduce((sum, account) => {
      const acct = balanceMap[account.id]
      return sum + (acct?.open_pnl ?? 0)
    }, 0)
    const totalLiveOpenTradesFromSummary = brokerAccounts.reduce((sum, account) => {
      const acct = balanceMap[account.id]
      return sum + (acct?.open_trades ?? 0)
    }, 0)
    const hasAnyBrokerOpenPnl = brokerAccounts.some(account => balanceMap[account.id]?.open_pnl != null)
    const hasAnyBrokerOpenTradesFromSummary = brokerAccounts.some(account => balanceMap[account.id]?.open_trades != null)

    const resolvedOpenTradesCount =
      hasAnyBrokerOpenTradesFromSummary ? totalLiveOpenTradesFromSummary : openTrades.length
    const channelNames = buildChannelDisplayNames((channelsMetaRes.data ?? []) as ChannelNameRow[])
    const logs = (logsRes.data ?? []) as Signal[]
    const symbolLookup = await buildSignalSymbolLookup(supabase, user!.id, logs)
    const logSymbols = buildCopierLogSymbolLabels(logs, symbolLookup)
    setChannelDisplayNames(channelNames)
    setCopierLogSymbols(logSymbols)
    setCopierLogs(logs)
    setAiExpertLogs(dedupePipelineParseAttempts((aiLogsRes.data ?? []) as AiExpertLogRow[]))
    setLinkedAccounts(brokerAccounts)
    setLinkedAccountBalances(balanceMap)
    const nextStats: DashboardStats = {
      accounts: activeBrokerCount,
      portfolioValue: totalPortfolioValue,
      totalEquity: totalEquityValue,
      tradesTaken: closedTrades.length,
      tradesWon: won,
      tradesLost: lost,
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
    setStats(nextStats)
    if (user) {
      const cacheKey = `${DASHBOARD_CACHE_PREFIX}:${user.id}`
      sessionStorage.setItem(cacheKey, JSON.stringify({
        stats: nextStats,
        copierLogs: logs,
        copierLogSymbols: logSymbols,
        channelDisplayNames: channelNames,
        linkedAccounts: brokerAccounts,
        linkedAccountBalances: balanceMap,
      }))
    }
    setChartTrades(resolveDashboardChartTrades(mtTradesRef.current, allTrades))
    if (!silent) setLoading(false)
    // Kick off live balance + trade refreshes in the background; both throttled internally.
    void refreshBrokerSummaries(brokerAccounts, balanceMap)
    void refreshMtTrades(brokerAccounts)
  }

  /**
   * Pull live trades (open + recent closed) from MetatraderAPI for every linked
   * broker and recompute the performance stats from them. Throttled to one call
   * per MT_TRADES_REFRESH_MS so the 15s auto-tick doesn't hammer the edge fn.
   */
  const refreshMtTrades = async (brokerAccounts?: BrokerAccount[]) => {
    const now = Date.now()
    if (now - lastMtTradesRefreshRef.current < MT_TRADES_REFRESH_MS) return
    const sourceAccounts = brokerAccounts ?? linkedAccounts
    const hasMtBroker = sourceAccounts.some((b) => {
      const uuid = (b.metaapi_account_id ?? '').trim()
      return b.is_active && uuid.length > 0 && !uuid.includes('|')
    })
    if (!hasMtBroker) return
    lastMtTradesRefreshRef.current = now

    let trades: MtTrade[]
    try {
      const res = await metatraderApi.trades({ scope: 'all' })
      trades = res.trades ?? []
    } catch {
      return
    }
    mtTradesRef.current = trades
    setChartTrades(resolveDashboardChartTrades(trades, []))
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
    const closedToday = trades.filter(t => t.status === 'closed' && inRange(t.closed_at, today0, tomorrow0))
    const closedYesterday = trades.filter(t => t.status === 'closed' && inRange(t.closed_at, yesterday0, today0))
    const positiveClosed = (rows: typeof trades) =>
      rows.map(t => t.profit).filter((p): p is number => typeof p === 'number' && p > 0)
    const negativeClosed = (rows: typeof trades) =>
      rows.map(t => t.profit).filter((p): p is number => typeof p === 'number' && p < 0)
    const posToday = positiveClosed(closedToday)
    const negToday = negativeClosed(closedToday)
    const posYest = positiveClosed(closedYesterday)
    const negYest = negativeClosed(closedYesterday)
    const topSymbol = (rows: typeof trades): string => {
      const counts = new Map<string, number>()
      for (const r of rows) if (r.symbol) counts.set(r.symbol, (counts.get(r.symbol) ?? 0) + 1)
      let best = '—'
      let max = 0
      for (const [s, c] of counts.entries()) if (c > max) { best = s; max = c }
      return best
    }

    setStats(prev => ({
      ...prev,
      totalVolume: today.reduce((sum, t) => sum + (t.lot_size ?? 0), 0),
      yesterdayTotalVolume: yesterday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0),
      bestTradeProfit: posToday.length ? Math.max(...posToday) : 0,
      yesterdayBestTradeProfit: posYest.length ? Math.max(...posYest) : 0,
      worstTradeProfit: negToday.length ? Math.min(...negToday) : 0,
      yesterdayWorstTradeProfit: negYest.length ? Math.min(...negYest) : 0,
      todayProfit: closedToday.reduce((sum, t) => sum + (t.profit ?? 0), 0),
      yesterdayProfit: closedYesterday.reduce((sum, t) => sum + (t.profit ?? 0), 0),
      mostTradedAsset: topSymbol(today),
      yesterdayMostTradedAsset: topSymbol(yesterday),
    }))
  }

  /**
   * Pull live balance/equity from MetatraderAPI for every connected broker and
   * merge the results into local state. Throttled so the auto-refresh ticker
   * doesn't hammer the edge function — at most once per BROKER_SUMMARY_REFRESH_MS.
   */
  const refreshBrokerSummaries = async (
    brokerAccounts?: BrokerAccount[],
    balanceSeed?: Record<string, { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number; open_trades?: number }>,
  ) => {
    const now = Date.now()
    if (now - lastBrokerRefreshRef.current < BROKER_SUMMARY_REFRESH_MS) return
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
        open_pnl: liveProfit,
        open_trades: liveOpenTrades,
      }
      // Persist live values across throttled refreshes / loadDashboard ticks.
      liveBrokerStateRef.current[r.id] = {
        open_pnl: typeof liveProfit === 'number' ? liveProfit : liveBrokerStateRef.current[r.id]?.open_pnl,
        open_trades: typeof liveOpenTrades === 'number' ? liveOpenTrades : liveBrokerStateRef.current[r.id]?.open_trades,
      }
    }
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
      return {
        ...prev,
        portfolioValue,
        totalEquity,
        openPnl: sawLivePnl ? openPnl : prev.openPnl,
        totalProfitLoss,
        ...(sawOpenPosCount ? { openPositions: mtOpenTotal, openTrades: mtOpenTotal } : {}),
      }
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

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6 lg:p-8 max-w-[1600px] mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-neutral-900 dark:text-neutral-50">Dashboard</h1>
        
      </div>

      {/* Stats bar */}
      <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 mb-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-neutral-100 dark:divide-neutral-800">
          <StatBlock
            label="Total Balance"
            value={loading ? '—' : `$${stats.totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            sub={loading ? '' : `Across ${stats.accounts} connected account${stats.accounts === 1 ? '' : 's'}`}
            subColor="text-neutral-400"
          />
          <StatBlock
            label="Today's Profit"
            value={loading ? '—' : formatMoney(stats.todayProfit)}
            sub={loading ? '' : formatVsYesterdayMoney(stats.todayProfit, stats.yesterdayProfit)}
            valueColor={
              loading
                ? 'text-neutral-900 dark:text-neutral-50'
                : stats.todayProfit > 0
                  ? 'text-teal-600'
                  : stats.todayProfit < 0
                    ? 'text-error-600'
                    : 'text-neutral-900 dark:text-neutral-50'
            }
            subColor={stats.todayProfit >= 0 ? 'text-neutral-400' : 'text-error-500'}
          />
          <StatBlock
            label="Trades Taken"
            value={loading ? '—' : String(stats.tradesTaken)}
            sub={loading ? '' : `Trades Won: ${stats.tradesWon} • Trades Lost: ${stats.tradesLost}`}
            subColor="text-neutral-400"
          />
          <StatBlock
            label="Open PnL"
            value={loading ? '—' : `$${stats.openPnl.toFixed(2)}`}
            sub={loading ? '' : `${stats.openPositions} open positions`}
            valueColor={
              loading
                ? 'text-neutral-900 dark:text-neutral-50'
                : stats.openPnl > 0
                  ? 'text-teal-600'
                  : stats.openPnl < 0
                    ? 'text-error-600'
                    : 'text-neutral-900 dark:text-neutral-50'
            }
            subColor={stats.openPnl >= 0 ? 'text-neutral-400' : 'text-error-500'}
          />
        </div>
        <div className="border-t border-neutral-100 dark:border-neutral-800 p-4 sm:p-5 grid grid-cols-2 lg:grid-cols-4 gap-4">
          <OverviewStat
            label="Active Signal Channels"
            value={loading ? '—' : String(stats.activeChannels)}
            sub={loading ? '' : 'Connected Telegram channels'}
            addTo="/copier-engine"
            addLabel="Manage channels"
          />
          <OverviewStat
            label="Open Trades"
            value={loading ? '—' : String(stats.openTrades)}
            sub={loading ? '' : 'Active broker positions'}
          />
          <OverviewStat
            label="Trading Accounts Connected"
            value={loading ? '—' : String(stats.accounts)}
            sub={loading ? '' : 'Active linked accounts'}
            addTo="/account-configuration"
            addLabel="Add or manage accounts"
          />
          <OverviewStat
            label="Trades Copied Today"
            value={loading ? '—' : String(stats.tradesCopiedToday)}
            sub={loading ? '' : 'Executed from channel signals'}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <TradeVolumeChart data={tradeVolume7Day} loading={loading} />
        <AccountGrowthChart
          data={accountGrowth.data}
          series={accountGrowth.series}
          loading={loading}
        />
      </div>

      {/* Lower panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* AI Expert Log */}
          <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 min-w-0">
          <div className="px-4 sm:px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-teal-500" />
              <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Channel Worker</span>
              <button className="text-neutral-300 hover:text-neutral-500 dark:text-neutral-400">
                <Info className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={() => navigate('/copier-engine')}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 dark:border-teal-600 text-teal-600 dark:text-teal-400 rounded-lg text-xs font-medium hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
            >
              Channels
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          {loading ? (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="px-5 py-3">
                  <div className="h-4 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-3/4 mb-1.5" />
                  <div className="h-3 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-1/3" />
                </div>
              ))}
            </div>
          ) : aiExpertLogs.length === 0 ? (
            <div className="px-5 py-10 text-sm text-neutral-400">No channel worker logs yet.</div>
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
              <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Copier Logs</span>
              <button className="text-neutral-300 hover:text-neutral-500 dark:text-neutral-400">
                <Info className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={() => navigate('/copier-logs')}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 dark:border-teal-600 text-teal-600 dark:text-teal-400 rounded-lg text-xs font-medium hover:bg-teal-50 dark:hover:bg-teal-950/50 transition-colors"
            >
              Copier Logs
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          <div className="overflow-x-auto">
          {/* Table header */}
          <div
            className={`${DASHBOARD_COPIER_LOG_GRID} min-w-[28rem] px-4 sm:px-5 py-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-medium text-neutral-400 uppercase tracking-wide`}
          >
            <span>Status</span>
            <span className="min-w-0">Channel</span>
            <span>Symbol</span>
            <span>Type</span>
            <span className="text-right">Time</span>
          </div>

          {loading ? (
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
              <p className="text-sm text-neutral-400 font-medium">No Data</p>
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
            <Clock className="w-4 h-4 text-teal-500" />
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

        {loading ? (
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
              <LinkedAccountRow key={account.id} account={account} accountSummary={linkedAccountBalances[account.id]} />
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
  sub: string
  subColor: string
  valueColor?: string
}) {
  return (
    <div className="px-4 py-4 sm:px-6 sm:py-5">
      <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mb-1.5 sm:mb-2">{label}</p>
      <p className={`text-xl sm:text-3xl font-semibold mb-1 sm:mb-1.5 ${valueColor}`}>{value}</p>
      <p className={`text-xs ${subColor}`}>{sub}</p>
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
  const parsed = signal.parsed_data as Record<string, unknown> | null
  const action = parsed?.action as string | undefined

  const statusConfig: Record<string, { color: string; label: string }> = {
    executed: { color: 'text-teal-700 bg-teal-50 dark:text-teal-300 dark:bg-teal-950/60', label: 'Executed' },
    skipped:  { color: 'text-warning-800 bg-warning-50 dark:!text-amber-100 dark:!bg-amber-900', label: 'Skipped' },
    failed:   { color: 'text-error-800 bg-error-50 dark:text-error-300 dark:bg-error-950/70', label: 'Failed' },
    pending:  { color: 'text-neutral-600 bg-neutral-100 dark:text-neutral-300 dark:bg-neutral-800', label: 'Pending' },
    parsed:   { color: 'text-teal-700 bg-teal-50 dark:text-teal-300 dark:bg-teal-950/60', label: 'Parsed' },
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

function LinkedAccountRow({
  account,
  accountSummary,
}: {
  account: BrokerAccount
  accountSummary?: { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number }
}) {
  const statusClass = account.is_active
    ? 'text-teal-700 border-teal-200 bg-teal-50 dark:text-teal-300 dark:border-teal-800 dark:bg-teal-950/50'
    : 'text-warning-700 border-warning-200 bg-warning-50 dark:text-warning-300 dark:border-warning-800 dark:bg-warning-950/40'
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
  const accountType = accountSummary?.account_type || '—'

  const accountLabel = account.label || 'Unnamed account'

  return (
    <div className="grid grid-cols-9 gap-2 px-4 sm:px-5 py-3 items-center hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 truncate">{accountLabel}</span>
        <span className="text-[11px] font-medium text-primary-600 uppercase">{account.platform}</span>
      </div>
      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{brokerText}</span>
      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{accountType}</span>
      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{balanceText}</span>
      <span className={`text-sm font-semibold ${pnlColor}`}>{pnl >= 0 ? '+' : '-'}{pnlText}</span>
      <span className="text-sm font-semibold text-teal-600">0.0%</span>
      <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">0%</span>
      <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">0.0%</span>
      <div className="flex justify-end">
        <span className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-xs font-semibold ${statusClass}`}>
          {account.is_active ? 'Active' : 'Warning'}
        </span>
      </div>
    </div>
  )
}
