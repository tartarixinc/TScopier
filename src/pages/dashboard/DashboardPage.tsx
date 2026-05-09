import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, ChevronRight, ChevronDown, Info, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import type { BrokerAccount, Signal, Trade } from '../../types/database'
import { inferBrokerLabelFromServer, resolveMtServerCandidate } from '../../lib/brokerFromServer'
import { AddAccountModal } from '../../components/ui/AddAccountModal'

interface DashboardStats {
  accounts: number
  portfolioValue: number
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
  totalProfitLoss: number
  yesterdayTotalProfitLoss: number
  bestTradeProfit: number | null
  yesterdayBestTradeProfit: number | null
  worstTradeProfit: number | null
  yesterdayWorstTradeProfit: number | null
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
}

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const EDGE_ACCOUNT_SUMMARY = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/metatrader-account-summary`
  const EDGE_BROKER_TRADES = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/metatrader-trades`
  const [stats, setStats] = useState<DashboardStats>({
    accounts: 0,
    portfolioValue: 0,
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
    totalProfitLoss: 0,
    yesterdayTotalProfitLoss: 0,
    bestTradeProfit: null,
    yesterdayBestTradeProfit: null,
    worstTradeProfit: null,
    yesterdayWorstTradeProfit: null,
    todayProfit: 0,
    yesterdayProfit: 0,
    mostProfitableChannel: '—',
    yesterdayMostProfitableChannel: '—',
    mostTradedAsset: '—',
    yesterdayMostTradedAsset: '—',
  })
  const [copierLogs, setCopierLogs] = useState<Signal[]>([])
  const [aiExpertLogs, setAiExpertLogs] = useState<AiExpertLogRow[]>([])
  const [linkedAccounts, setLinkedAccounts] = useState<BrokerAccount[]>([])
  const [linkedAccountBalances, setLinkedAccountBalances] = useState<Record<string, { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number; open_trades?: number }>>({})
  const [showPlatformModal, setShowPlatformModal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showExpandedStats, setShowExpandedStats] = useState(false)
  const [showExpandedPerformance, setShowExpandedPerformance] = useState(false)
  const AUTO_REFRESH_MS = 15000
  const DASHBOARD_CACHE_PREFIX = 'dashboard_cache_v2'
  const formatMoney = (value: number | null | undefined) =>
    `$${(Number.isFinite(value as number) ? Number(value) : 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const formatNumber = (value: number | null | undefined) =>
    (Number.isFinite(value as number) ? Number(value) : 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const formatVsYesterdayNumber = (todayValue: number | null | undefined, yesterdayValue: number | null | undefined) =>
    `vs yesterday: ${formatNumber(yesterdayValue)} (${((Number.isFinite(todayValue as number) ? Number(todayValue) : 0) - (Number.isFinite(yesterdayValue as number) ? Number(yesterdayValue) : 0)) >= 0 ? '+' : ''}${formatNumber((Number.isFinite(todayValue as number) ? Number(todayValue) : 0) - (Number.isFinite(yesterdayValue as number) ? Number(yesterdayValue) : 0))})`
  const formatVsYesterdayMoney = (todayValue: number | null | undefined, yesterdayValue: number | null | undefined) =>
    `vs yesterday: ${formatMoney(yesterdayValue)} (${((Number.isFinite(todayValue as number) ? Number(todayValue) : 0) - (Number.isFinite(yesterdayValue as number) ? Number(yesterdayValue) : 0)) >= 0 ? '+' : ''}${formatMoney((Number.isFinite(todayValue as number) ? Number(todayValue) : 0) - (Number.isFinite(yesterdayValue as number) ? Number(yesterdayValue) : 0))})`
  const formatVsYesterdayText = (yesterdayValue: string) => `vs yesterday: ${yesterdayValue || '—'}`

  useEffect(() => {
    if (!user) return
    const cacheKey = `${DASHBOARD_CACHE_PREFIX}:${user.id}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as {
          stats?: DashboardStats
          copierLogs?: Signal[]
          linkedAccounts?: BrokerAccount[]
          linkedAccountBalances?: Record<string, { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number; open_trades?: number }>
        }
        if (parsed.stats) {
          setStats(prev => ({ ...prev, ...parsed.stats }))
        }
        if (parsed.copierLogs) setCopierLogs(parsed.copierLogs)
        if (parsed.linkedAccounts) setLinkedAccounts(parsed.linkedAccounts)
        if (parsed.linkedAccountBalances) setLinkedAccountBalances(parsed.linkedAccountBalances)
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
      supabase.from('telegram_channels').select('id,display_name').eq('user_id', user!.id),
      supabase.from('trade_execution_logs').select('id,created_at,action,status,request_payload,response_payload,error_message').eq('user_id', user!.id).order('created_at', { ascending: false }).limit(12),
    ])

    const allTrades = (tradesRes.data ?? []) as Trade[]
    const openTrades = allTrades.filter(t => t.status === 'open')
    const closedTrades = allTrades.filter(t => t.status === 'closed')
    const todaySignals = (todaySignalsRes.data ?? []) as { status: string }[]
    const copiedToday = todaySignals.filter(s => s.status === 'executed').length
    const openPnlFromTrades = openTrades.reduce((sum, t) => sum + (t.profit ?? 0), 0)
    const isInRange = (dateString: string | null | undefined, start: Date, end: Date) => {
      if (!dateString) return false
      const ts = new Date(dateString).getTime()
      return Number.isFinite(ts) && ts >= start.getTime() && ts < end.getTime()
    }
    const tradesToday = allTrades.filter(t => isInRange(t.opened_at, todayStart, tomorrowStart))
    const tradesYesterday = allTrades.filter(t => isInRange(t.opened_at, yesterdayStart, todayStart))
    const totalProfitLoss = tradesToday.reduce((sum, t) => sum + (t.profit ?? 0), 0)
    const yesterdayTotalProfitLoss = tradesYesterday.reduce((sum, t) => sum + (t.profit ?? 0), 0)
    const totalVolume = tradesToday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0)
    const yesterdayTotalVolume = tradesYesterday.reduce((sum, t) => sum + (t.lot_size ?? 0), 0)
    const profitableTradesToday = tradesToday.filter(t => typeof t.profit === 'number' && Number.isFinite(t.profit))
    const profitableTradesYesterday = tradesYesterday.filter(t => typeof t.profit === 'number' && Number.isFinite(t.profit))
    const bestTradeProfit = profitableTradesToday.length ? Math.max(...profitableTradesToday.map(t => t.profit ?? 0)) : null
    const yesterdayBestTradeProfit = profitableTradesYesterday.length ? Math.max(...profitableTradesYesterday.map(t => t.profit ?? 0)) : null
    const worstTradeProfit = profitableTradesToday.length ? Math.min(...profitableTradesToday.map(t => t.profit ?? 0)) : null
    const yesterdayWorstTradeProfit = profitableTradesYesterday.length ? Math.min(...profitableTradesYesterday.map(t => t.profit ?? 0)) : null
    const todayProfit = allTrades
      .filter(t => isInRange(t.closed_at, todayStart, tomorrowStart))
      .reduce((sum, t) => sum + (t.profit ?? 0), 0)
    const yesterdayProfit = allTrades
      .filter(t => isInRange(t.closed_at, yesterdayStart, todayStart))
      .reduce((sum, t) => sum + (t.profit ?? 0), 0)
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
    const mostProfitableChannel = (() => {
      const signals = (allSignalsRes.data ?? []) as Array<{ id: string; channel_id: string | null }>
      const channels = (channelsMetaRes.data ?? []) as Array<{ id: string; display_name: string }>
      const signalToChannel = new Map<string, string | null>()
      for (const s of signals) signalToChannel.set(s.id, s.channel_id)
      const channelNameById = new Map<string, string>()
      for (const c of channels) channelNameById.set(c.id, c.display_name || 'Unnamed channel')
      const pnlByChannel = new Map<string, number>()
      for (const trade of tradesToday) {
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
      for (const trade of tradesYesterday) {
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
    const token = (await supabase.auth.getSession()).data.session?.access_token
    const balanceEntries = await Promise.all(
      brokerAccounts.map(async (account) => {
        if (!token) return [account.id, {}] as const
        try {
          const res = await fetch(EDGE_ACCOUNT_SUMMARY, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ broker_account_id: account.id }),
          })
          const data = await res.json()
          if (!res.ok || !data?.summary) return [account.id, {}] as const
          const s = data.summary as Record<string, unknown>
          const balance = Number(s.balance ?? s.Balance)
          const equity = Number(s.equity ?? s.Equity)
          const currency = String(s.currency ?? s.Currency ?? '')
          const broker = String(s.broker ?? s.Broker ?? '').trim()
          const mt_server_hint = String(s.mt_server_hint ?? '').trim()
          const accountTypeRaw = String(s.account_type ?? s.accountType ?? s.AccountType ?? '').toLowerCase()
          const open_pnl_num = Number(s.open_pnl ?? s.openProfit ?? s.OpenProfit ?? s.floatingProfit ?? s.FloatingProfit)
          const open_trades_num = Number(s.open_trades ?? s.openTrades ?? s.OpenTrades)
          const account_type = accountTypeRaw === 'demo' ? 'Demo' : accountTypeRaw === 'live' ? 'Live' : undefined
          return [account.id, {
            balance: Number.isFinite(balance) ? balance : undefined,
            equity: Number.isFinite(equity) ? equity : undefined,
            currency: currency || undefined,
            broker: broker || undefined,
            mt_server_hint: mt_server_hint || undefined,
            account_type,
            open_pnl: Number.isFinite(open_pnl_num) ? open_pnl_num : undefined,
            open_trades: Number.isFinite(open_trades_num) ? open_trades_num : undefined,
          }] as const
        } catch {
          return [account.id, {}] as const
        }
      })
    )
    const balanceMap = Object.fromEntries(balanceEntries) as Record<string, { balance?: number; equity?: number; currency?: string; broker?: string; mt_server_hint?: string; account_type?: 'Live' | 'Demo'; open_pnl?: number; open_trades?: number }>
    const totalPortfolioValue = brokerAccounts.reduce((sum, account) => {
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

    let liveOpenTradesCount: number | null = null
    if (token) {
      try {
        const openTradesRes = await fetch(EDGE_BROKER_TRADES, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ filter: 'open' }),
        })
        const openTradesData = await openTradesRes.json()
        if (openTradesRes.ok && Array.isArray(openTradesData?.trades)) {
          liveOpenTradesCount = openTradesData.trades.length
        }
      } catch {
        // fallback below
      }
    }

    const resolvedOpenTradesCount =
      liveOpenTradesCount ??
      (hasAnyBrokerOpenTradesFromSummary ? totalLiveOpenTradesFromSummary : openTrades.length)
    setCopierLogs((logsRes.data ?? []) as Signal[])
    setAiExpertLogs((aiLogsRes.data ?? []) as AiExpertLogRow[])
    setLinkedAccounts(brokerAccounts)
    setLinkedAccountBalances(balanceMap)
    const nextStats: DashboardStats = {
      accounts: activeBrokerCount,
      portfolioValue: totalPortfolioValue,
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
        copierLogs: (logsRes.data ?? []) as Signal[],
        linkedAccounts: brokerAccounts,
        linkedAccountBalances: balanceMap,
      }))
    }
    if (!silent) setLoading(false)
  }

  return (
    <div className="p-6 lg:p-8">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-neutral-900">Dashboard</h1>
        
      </div>

      {/* Stats bar */}
      <div className="bg-white rounded-xl border border-neutral-100 shadow-card mb-6">
        <div className="grid grid-cols-4 divide-x divide-neutral-100">
          <StatBlock
            label="Total Balance"
            value={loading ? '—' : `$${stats.portfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            sub={loading ? '' : `Across ${stats.accounts} connected account${stats.accounts === 1 ? '' : 's'}`}
            subColor="text-neutral-400"
          />
          <StatBlock
            label="Active Trades"
            value={loading ? '—' : String(stats.openTrades)}
            sub={loading ? '' : `${stats.openPositions} open positions`}
            subColor="text-neutral-400"
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
                ? 'text-neutral-900'
                : stats.openPnl > 0
                  ? 'text-teal-600'
                  : stats.openPnl < 0
                    ? 'text-error-600'
                    : 'text-neutral-900'
            }
            subColor={stats.openPnl >= 0 ? 'text-neutral-400' : 'text-error-500'}
          />
        </div>
        <div className="border-t border-neutral-100 px-5 py-3">
          <button
            onClick={() => setShowExpandedStats(prev => !prev)}
            className="w-full flex items-center justify-between text-xs font-medium text-neutral-600 hover:text-neutral-800 transition-colors"
          >
            <span>More Stats</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${showExpandedStats ? 'rotate-180' : 'rotate-0'}`} />
          </button>
        </div>
        {showExpandedStats && (
          <div className="border-t border-neutral-100 p-5 grid grid-cols-2 lg:grid-cols-4 gap-4">
            <OverviewStat
              label="Active Signal Channels"
              value={loading ? '—' : String(stats.activeChannels)}
              sub={loading ? '' : 'Connected Telegram channels'}
            />
            <OverviewStat
              label="Open Trades"
              value={loading ? '—' : String(stats.openTrades)}
              sub={loading ? '' : 'Currently active broker positions'}
            />
            <OverviewStat
              label="Trading Accounts Connected"
              value={loading ? '—' : String(stats.accounts)}
              sub={loading ? '' : 'Active linked accounts'}
            />
            <OverviewStat
              label="Trades Copied Today"
              value={loading ? '—' : String(stats.tradesCopiedToday)}
              sub={loading ? '' : 'Executed from channel signals'}
            />
          </div>
        )}
      </div>

      {/* Today's performance */}
      <div className="bg-white rounded-xl border border-neutral-100 shadow-card mb-6">
        <div className="px-5 py-4 border-b border-neutral-100 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-neutral-900">Today&apos;s performance</p>
            <p className="text-xs text-neutral-400">Daily performance snapshot with comparison to yesterday</p>
          </div>
          {!showExpandedPerformance && (
            <div className="text-right">
              <p className="text-[11px] text-neutral-500">Today Profit</p>
              <p className="text-sm font-semibold text-neutral-900">{loading ? '—' : formatMoney(stats.todayProfit)}</p>
            </div>
          )}
        </div>
        <div className="border-t border-neutral-100 px-5 py-3">
          <button
            onClick={() => setShowExpandedPerformance(prev => !prev)}
            className="w-full flex items-center justify-between text-xs font-medium text-neutral-600 hover:text-neutral-800 transition-colors"
          >
            <span>More Performance Stats</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${showExpandedPerformance ? 'rotate-180' : 'rotate-0'}`} />
          </button>
        </div>
        {showExpandedPerformance && (
          <div className="border-t border-neutral-100 p-5 grid grid-cols-2 lg:grid-cols-4 gap-4">
            <OverviewStat label="Total Profit & Loss" value={loading ? '—' : formatMoney(stats.totalProfitLoss)} sub={loading ? '' : formatVsYesterdayMoney(stats.totalProfitLoss, stats.yesterdayTotalProfitLoss)} />
            <OverviewStat label="Total Volume" value={loading ? '—' : formatNumber(stats.totalVolume)} sub={loading ? '' : formatVsYesterdayNumber(stats.totalVolume, stats.yesterdayTotalVolume)} />
            <OverviewStat label="Best Trade" value={loading ? '—' : (stats.bestTradeProfit == null ? '—' : formatMoney(stats.bestTradeProfit))} sub={loading ? '' : `vs yesterday: ${stats.yesterdayBestTradeProfit == null ? '—' : formatMoney(stats.yesterdayBestTradeProfit)}`} />
            <OverviewStat label="Worst Trade" value={loading ? '—' : (stats.worstTradeProfit == null ? '—' : formatMoney(stats.worstTradeProfit))} sub={loading ? '' : `vs yesterday: ${stats.yesterdayWorstTradeProfit == null ? '—' : formatMoney(stats.yesterdayWorstTradeProfit)}`} />
            <OverviewStat label="Today Profit" value={loading ? '—' : formatMoney(stats.todayProfit)} sub={loading ? '' : formatVsYesterdayMoney(stats.todayProfit, stats.yesterdayProfit)} />
            <OverviewStat label="Most Profitable Channel" value={loading ? '—' : stats.mostProfitableChannel} sub={loading ? '' : formatVsYesterdayText(stats.yesterdayMostProfitableChannel)} />
            <OverviewStat label="Most Traded Asset" value={loading ? '—' : stats.mostTradedAsset} sub={loading ? '' : formatVsYesterdayText(stats.yesterdayMostTradedAsset)} />
            <OverviewStat label="Total Signals" value={loading ? '—' : String(stats.totalSignals)} sub={loading ? '' : formatVsYesterdayNumber(stats.totalSignals, stats.yesterdayTotalSignals)} />
          </div>
        )}
      </div>

      

      {/* Lower panels */}
      <div className="grid grid-cols-2 gap-6">
        {/* AI Expert Log */}
        <div className="bg-white rounded-xl border border-neutral-100 shadow-card">
          <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-teal-500" />
              <span className="text-sm font-semibold text-neutral-900">AI Expert Log</span>
              <button className="text-neutral-300 hover:text-neutral-500">
                <Info className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={() => navigate('/copier-engine')}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 text-teal-600 rounded-lg text-xs font-medium hover:bg-teal-50 transition-colors"
            >
              Channels
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          {loading ? (
            <div className="divide-y divide-neutral-50">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="px-5 py-3">
                  <div className="h-4 bg-neutral-100 rounded animate-pulse w-3/4 mb-1.5" />
                  <div className="h-3 bg-neutral-100 rounded animate-pulse w-1/3" />
                </div>
              ))}
            </div>
          ) : aiExpertLogs.length === 0 ? (
            <div className="px-5 py-10 text-sm text-neutral-400">No AI trade process logs yet.</div>
          ) : (
            <div className="divide-y divide-neutral-50 max-h-96 overflow-y-auto">
              {aiExpertLogs.map(row => <AiExpertLogItem key={row.id} row={row} />)}
            </div>
          )}
        </div>

        {/* Copier Logs */}
        <div className="bg-white rounded-xl border border-neutral-100 shadow-card">
          <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-teal-500" />
              <span className="text-sm font-semibold text-neutral-900">Copier Logs</span>
              <button className="text-neutral-300 hover:text-neutral-500">
                <Info className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={() => navigate('/copier-logs')}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 text-teal-600 rounded-lg text-xs font-medium hover:bg-teal-50 transition-colors"
            >
              Copier Logs
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          {/* Table header */}
          <div className="grid grid-cols-6 gap-2 px-5 py-3 border-b border-neutral-100 text-xs font-medium text-neutral-400 uppercase tracking-wide">
            <span>Status</span>
            <span>Channel</span>
            <span className="col-span-2">Symbol</span>
            <span>Type</span>
            <span className="text-right">P/L</span>
          </div>

          {loading ? (
            <div className="divide-y divide-neutral-50">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="px-5 py-3 flex gap-4">
                  {[...Array(6)].map((_, j) => (
                    <div key={j} className="h-4 bg-neutral-100 rounded animate-pulse flex-1" />
                  ))}
                </div>
              ))}
            </div>
          ) : copierLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-5">
              <div className="w-20 h-20 bg-neutral-100 rounded-2xl flex items-center justify-center mb-3 relative">
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
            <div className="divide-y divide-neutral-50 max-h-80 overflow-y-auto">
              {copierLogs.map(log => <LogRow key={log.id} signal={log} />)}
            </div>
          )}
        </div>
      </div>

      {/* Linked Accounts */}
      <div className="mt-6 bg-white rounded-xl border border-neutral-100 shadow-card">
        <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-teal-500" />
            <div>
              <p className="text-sm font-semibold text-neutral-900">Linked Accounts</p>
              <p className="text-xs text-neutral-400">Connected broker accounts used by copier</p>
            </div>
          </div>
          <button
            onClick={() => setShowPlatformModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-teal-500 text-teal-600 rounded-lg text-xs font-medium hover:bg-teal-50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>

        <div className="grid grid-cols-9 gap-2 px-5 py-3 border-b border-neutral-100 text-xs font-medium text-neutral-400">
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
          <div className="divide-y divide-neutral-50">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="px-5 py-3 flex gap-4">
                {[...Array(9)].map((_, j) => (
                  <div key={j} className="h-4 bg-neutral-100 rounded animate-pulse flex-1" />
                ))}
              </div>
            ))}
          </div>
        ) : linkedAccounts.length === 0 ? (
          <div className="px-5 py-8 text-sm text-neutral-400">No linked accounts yet.</div>
        ) : (
          <div className="divide-y divide-neutral-50">
            {linkedAccounts.map(account => (
              <LinkedAccountRow key={account.id} account={account} accountSummary={linkedAccountBalances[account.id]} />
            ))}
          </div>
        )}
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

function StatBlock({ label, value, sub, subColor, valueColor = 'text-neutral-900' }: {
  label: string
  value: string
  sub: string
  subColor: string
  valueColor?: string
}) {
  return (
    <div className="px-6 py-5">
      <p className="text-sm text-neutral-500 mb-2">{label}</p>
      <p className={`text-3xl font-semibold mb-1.5 ${valueColor}`}>{value}</p>
      <p className={`text-xs ${subColor}`}>{sub}</p>
    </div>
  )
}

function OverviewStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs text-neutral-500 mb-1">{label}</p>
      <p className="text-2xl font-semibold text-neutral-900">{value}</p>
      {sub ? <p className="text-xs text-neutral-400 mt-1">{sub}</p> : null}
    </div>
  )
}

function AiExpertLogItem({ row }: { row: AiExpertLogRow }) {
  const payload = (row.request_payload ?? {}) as Record<string, unknown>
  const response = (row.response_payload ?? {}) as Record<string, unknown>
  const parsed = (payload.parsed ?? {}) as Record<string, unknown>
  const symbol = String(parsed.symbol ?? payload.symbol ?? response.symbol ?? 'trade')
  const action = String(parsed.action ?? row.action ?? 'action').toLowerCase()
  const lot = Number(parsed.lot_size ?? response.volume ?? payload.volume)
  const entry = Number(parsed.entry_price ?? response.price ?? payload.price)
  const tp = Array.isArray(parsed.tp) ? Number(parsed.tp[0]) : Number(parsed.tp)
  const sl = Number(parsed.sl)
  const hasLot = Number.isFinite(lot) && lot > 0
  const hasEntry = Number.isFinite(entry) && entry > 0
  const hasTp = Number.isFinite(tp) && tp > 0
  const hasSl = Number.isFinite(sl) && sl > 0

  const message = (() => {
    if (row.action === 'pipeline_parse_dispatch') {
      return row.status === 'success'
        ? `AI interpreted a new signal for ${symbol}.`
        : `AI signal parsing failed for ${symbol}.`
    }
    if (row.status === 'success' && (action === 'buy' || action === 'sell')) {
      return `Opened a ${hasLot ? lot.toFixed(2) : 'new'} ${action.toUpperCase()} position on ${symbol}${hasEntry ? ` @ ${entry}` : ''}${hasTp || hasSl ? ` (${hasTp ? `TP1 ${tp}` : ''}${hasTp && hasSl ? ', ' : ''}${hasSl ? `SL ${sl}` : ''})` : ''}.`
    }
    if (row.status === 'failed') {
      return `Failed to execute ${action.toUpperCase()} on ${symbol}${row.error_message ? `: ${row.error_message}` : '.'}`
    }
    return `Processed ${action.toUpperCase()} workflow for ${symbol}.`
  })()

  return (
    <div className="px-5 py-3">
      <p className="text-sm text-neutral-800">{message}</p>
      <p className="text-[11px] text-neutral-400 mt-1">{new Date(row.created_at).toLocaleString()}</p>
    </div>
  )
}

function LogRow({ signal }: { signal: Signal }) {
  const parsed = signal.parsed_data as Record<string, unknown> | null
  const action = parsed?.action as string | undefined
  const symbol = parsed?.symbol != null ? String(parsed.symbol) : '—'

  const statusConfig: Record<string, { color: string; label: string }> = {
    executed: { color: 'text-teal-600 bg-teal-50', label: 'Executed' },
    skipped:  { color: 'text-warning-600 bg-warning-50', label: 'Skipped' },
    failed:   { color: 'text-error-600 bg-error-50', label: 'Failed' },
    pending:  { color: 'text-neutral-500 bg-neutral-100', label: 'Pending' },
    parsed:   { color: 'text-teal-600 bg-teal-50', label: 'Parsed' },
  }

  const s = statusConfig[signal.status] ?? { color: 'text-neutral-500 bg-neutral-100', label: signal.status }
  const isBuy = action === 'buy'

  return (
    <div className="grid grid-cols-6 gap-2 px-5 py-3 items-center hover:bg-neutral-50 transition-colors">
      <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${s.color}`}>
        {s.label}
      </span>
      <span className="text-xs text-neutral-500 truncate">—</span>
      <span className="col-span-2 text-sm font-medium text-neutral-900">{symbol}</span>
      <span className={`text-xs font-medium uppercase ${isBuy ? 'text-primary-600' : action === 'sell' ? 'text-error-600' : 'text-neutral-500'}`}>
        {action ?? '—'}
      </span>
      <span className="text-xs text-neutral-400 text-right">—</span>
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
    ? 'text-teal-600 border-teal-200 bg-teal-50'
    : 'text-warning-600 border-warning-200 bg-warning-50'
  const balanceText = accountSummary?.balance != null
    ? `${accountSummary.currency ?? '$'} ${accountSummary.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '$0.00'
  const pnl = accountSummary?.open_pnl ?? ((accountSummary?.equity ?? 0) - (accountSummary?.balance ?? 0))
  const pnlColor = pnl >= 0 ? 'text-teal-600' : 'text-error-600'
  const pnlText = `${accountSummary?.currency ?? '$'} ${Math.abs(pnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const apiRaw = (accountSummary?.broker ?? '').trim()
  const fromApi = inferBrokerLabelFromServer(apiRaw) || apiRaw
  const server = resolveMtServerCandidate(account, accountSummary?.mt_server_hint)
  const fromServer = inferBrokerLabelFromServer(server) || (server?.trim() ?? '')
  const brokerText = fromApi || fromServer || '—'
  const accountType = accountSummary?.account_type || '—'

  return (
    <div className="grid grid-cols-9 gap-2 px-5 py-3 items-center hover:bg-neutral-50 transition-colors">
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-neutral-900">{account.label || 'Unnamed account'}</span>
        <span className="text-[11px] font-medium text-primary-600 uppercase">{account.platform}</span>
      </div>
      <span className="text-sm font-medium text-neutral-900">{brokerText}</span>
      <span className="text-sm font-medium text-neutral-900">{accountType}</span>
      <span className="text-sm font-medium text-neutral-900">{balanceText}</span>
      <span className={`text-sm font-semibold ${pnlColor}`}>{pnl >= 0 ? '+' : '-'}{pnlText}</span>
      <span className="text-sm font-semibold text-teal-600">0.0%</span>
      <span className="text-sm font-semibold text-neutral-900">0%</span>
      <span className="text-sm font-semibold text-neutral-900">0.0%</span>
      <div className="flex justify-end">
        <span className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-xs font-semibold ${statusClass}`}>
          {account.is_active ? 'Active' : 'Warning'}
        </span>
      </div>
    </div>
  )
}
