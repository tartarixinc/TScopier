import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { resolveDashboardChartTrades } from '../lib/dashboardCharts'
import { computeLinkedAccountPerformanceMap } from '../lib/dashboardTradeStats'
import { fetchBrokerMtTrades } from '../lib/brokerTradeHistory'
import {
  PERFORMANCE_CACHE_TTL_MS,
  performanceCacheKey,
  type PerformanceCachePayload,
} from '../lib/performanceSessionCache'
import { performancePayloadFromDashboardCache } from '../lib/performanceCacheBridge'
import { readSessionCache, writeSessionCache } from '../lib/sessionDataCache'
import { fxsocketBroker, type MtTrade } from '../lib/fxsocketBroker'
import { effectiveAccountSummaryBalance } from '../lib/effectiveBrokerBalance'
import {
  aggregateAccountPerformance,
  chartTradesToStatsRows,
  computePeriodStatsFromChartTrades,
  computePeriodTradeStats,
  mtTradesToStatsRows,
  type PerformancePeriod,
} from '../lib/performanceAnalytics'
import {
  buildPerformanceChannelLinkMaps,
  normalizeChannelLinkMaps,
  EMPTY_CHANNEL_LINK_MAPS,
  type PerformanceChannelLinkMaps,
} from '../lib/performanceInsights'
import { BROKER_ACCOUNT_CLIENT_SELECT } from '../lib/brokerAccountSelect'
import { filterMtTradesSinceConnect } from '../lib/tradesSinceConnect'
import type { BrokerAccount } from '../types/database'

import { isFxsocketLinkedBroker } from '../lib/brokerLink'

function hasStaleEmptyBrokerHistory(payload: PerformanceCachePayload): boolean {
  return payload.mtTrades.length === 0 && payload.accounts.some(isFxsocketLinkedBroker)
}

async function fetchPerformancePayload(userId: string): Promise<PerformanceCachePayload> {
  const [brokerRes, channelsRes, dbTradesRes, attributionRes, signalsRes] = await Promise.all([
    supabase
      .from('broker_accounts')
      .select(BROKER_ACCOUNT_CLIENT_SELECT)
      .eq('user_id', userId),
    supabase
      .from('telegram_channels')
      .select('id, display_name, channel_username')
      .eq('user_id', userId),
    supabase
      .from('trades')
      .select('broker_account_id, metaapi_order_id, signal_id, telegram_channel_id')
      .eq('user_id', userId),
    supabase
      .from('trade_channel_attributions')
      .select('broker_account_id, metaapi_order_id, signal_id, channel_id, channel_label')
      .eq('user_id', userId),
    supabase.from('signals').select('id, channel_id').eq('user_id', userId),
  ])
  if (brokerRes.error) throw brokerRes.error

  const linked = (brokerRes.data ?? []) as unknown as BrokerAccount[]
  const mtBrokers = linked.filter(isFxsocketLinkedBroker)

  let trades: MtTrade[] = []
  if (mtBrokers.length > 0) {
    trades = await fetchBrokerMtTrades({ scope: 'performance', historyProfile: 'trades' })
    trades = filterMtTradesSinceConnect(trades, linked)
  }

  const channelLinkMaps = buildPerformanceChannelLinkMaps(
    (channelsRes.data ?? []) as Array<{
      id: string
      display_name: string
      channel_username?: string | null
    }>,
    (dbTradesRes.data ?? []) as Array<{
      broker_account_id: string | null
      metaapi_order_id: string | null
      signal_id: string | null
      telegram_channel_id: string | null
    }>,
    (signalsRes.data ?? []) as Array<{ id: string; channel_id: string | null }>,
    (attributionRes.data ?? []) as Array<{
      broker_account_id: string | null
      metaapi_order_id: string | null
      signal_id: string | null
      channel_id: string | null
      channel_label: string | null
    }>,
  )

  const equity: Record<string, number> = {}
  const balance: Record<string, number> = {}
  const baselineById: Record<string, number> = {}

  await Promise.all(
    linked.map(async account => {
      if (!isFxsocketLinkedBroker(account)) {
        const eq = account.last_equity ?? account.last_balance
        const bal = account.last_balance ?? account.last_equity
        if (eq != null && Number.isFinite(Number(eq))) equity[account.id] = Number(eq)
        if (bal != null && Number.isFinite(Number(bal))) balance[account.id] = Number(bal)
        return
      }
      try {
        const { account: refreshed, summary } = await fxsocketBroker.refreshSummary(account.id)
        const eq = summary?.equity ?? refreshed.last_equity ?? effectiveAccountSummaryBalance(summary) ?? refreshed.last_balance
        const bal = refreshed.last_balance ?? effectiveAccountSummaryBalance(summary) ?? refreshed.last_equity ?? summary?.equity
        if (eq != null && Number.isFinite(Number(eq))) equity[account.id] = Number(eq)
        if (bal != null && Number.isFinite(Number(bal))) balance[account.id] = Number(bal)
        const storedBaseline = refreshed.performance_baseline_balance ?? account.performance_baseline_balance
        if (storedBaseline != null && Number.isFinite(Number(storedBaseline)) && Number(storedBaseline) > 0) {
          baselineById[account.id] = Number(storedBaseline)
        }
      } catch {
        const eq = account.last_equity ?? account.last_balance
        const bal = account.last_balance ?? account.last_equity
        if (eq != null && Number.isFinite(Number(eq))) equity[account.id] = Number(eq)
        if (bal != null && Number.isFinite(Number(bal))) balance[account.id] = Number(bal)
      }
    }),
  )

  const accounts = linked.map(a => {
    const baseline = baselineById[a.id]
    return baseline != null ? { ...a, performance_baseline_balance: baseline } : a
  })

  return {
    accounts,
    mtTrades: trades,
    equityByAccountId: equity,
    balanceByAccountId: balance,
    channelLinkMaps,
  }
}

export function usePerformanceData(userId: string | undefined) {
  const [accounts, setAccounts] = useState<BrokerAccount[]>([])
  const [mtTrades, setMtTrades] = useState<MtTrade[]>([])
  const [equityByAccountId, setEquityByAccountId] = useState<Record<string, number>>({})
  const [balanceByAccountId, setBalanceByAccountId] = useState<Record<string, number>>({})
  const [channelLinkMaps, setChannelLinkMaps] = useState<PerformanceChannelLinkMaps>(EMPTY_CHANNEL_LINK_MAPS)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const inflightRef = useRef(false)
  const mtTradesRef = useRef<MtTrade[]>([])
  const hydratedUserRef = useRef<string | null>(null)
  const payloadRef = useRef<PerformanceCachePayload | null>(null)

  const persistPayload = useCallback(
    (payload: PerformanceCachePayload) => {
      payloadRef.current = payload
      if (userId) writeSessionCache(performanceCacheKey(userId), payload)
    },
    [userId],
  )

  const applyPayload = useCallback((payload: PerformanceCachePayload) => {
    payloadRef.current = payload
    setAccounts(payload.accounts)
    mtTradesRef.current = payload.mtTrades
    setMtTrades(payload.mtTrades)
    setEquityByAccountId(payload.equityByAccountId)
    setBalanceByAccountId(payload.balanceByAccountId)
    setChannelLinkMaps(normalizeChannelLinkMaps(payload.channelLinkMaps))
  }, [])

  const load = useCallback(
    async (opts?: { force?: boolean; background?: boolean }) => {
      if (!userId || inflightRef.current) return
      const key = performanceCacheKey(userId)
      const cached =
        !opts?.force ? readSessionCache<PerformanceCachePayload>(key, PERFORMANCE_CACHE_TTL_MS) : null

      if (cached && !opts?.force) {
        applyPayload(cached.data)
        setLastUpdated(new Date(cached.fetchedAt))
        setError(null)
        const staleEmptyBrokerHistory = hasStaleEmptyBrokerHistory(cached.data)
        if (!staleEmptyBrokerHistory && Date.now() - cached.fetchedAt < PERFORMANCE_CACHE_TTL_MS) {
          if (!opts?.background) setLoading(false)
          return
        }
        if (!opts?.background && !staleEmptyBrokerHistory) setLoading(false)
      }

      inflightRef.current = true
      if (opts?.background) {
        if (payloadRef.current && hasStaleEmptyBrokerHistory(payloadRef.current)) {
          setRefreshing(true)
        }
      } else if (opts?.force || cached) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      setError(null)

      try {
        const payload = await fetchPerformancePayload(userId)
        const fetchedAt = writeSessionCache(key, payload)
        applyPayload(payload)
        payloadRef.current = payload
        setLastUpdated(new Date(fetchedAt))
      } catch (e) {
        if (!cached) {
          setError(e instanceof Error ? e.message : 'Failed to load performance data')
        }
      } finally {
        inflightRef.current = false
        setLoading(false)
        setRefreshing(false)
      }
    },
    [userId, applyPayload],
  )

  useEffect(() => {
    if (!userId) {
      hydratedUserRef.current = null
      setLoading(false)
      return
    }

    if (hydratedUserRef.current !== userId) {
      hydratedUserRef.current = userId
      const key = performanceCacheKey(userId)
      let cached = readSessionCache<PerformanceCachePayload>(key, PERFORMANCE_CACHE_TTL_MS)
      if (!cached) {
        const bridged = performancePayloadFromDashboardCache(userId)
        if (bridged) {
          writeSessionCache(key, bridged)
          cached = { data: bridged, fetchedAt: Date.now() }
        }
      }
      if (cached) {
        applyPayload(cached.data)
        setLastUpdated(new Date(cached.fetchedAt))
        setError(null)
        const staleEmptyBrokerHistory = hasStaleEmptyBrokerHistory(cached.data)
        if (!staleEmptyBrokerHistory && Date.now() - cached.fetchedAt < PERFORMANCE_CACHE_TTL_MS) {
          setLoading(false)
          return
        }
        if (staleEmptyBrokerHistory) {
          setLoading(true)
          void load()
          return
        }
        setLoading(false)
        void load({ background: true })
        return
      }
      setLoading(true)
    }

    void load()
  }, [userId, load, applyPayload])

  const hasMtHistory = mtTrades.length > 0

  const chartTrades = useMemo(() => {
    if (hasMtHistory) {
      return resolveDashboardChartTrades(mtTrades, [])
    }
    return []
  }, [hasMtHistory, mtTrades])

  const statsRows = useMemo(
    () => (hasMtHistory ? mtTradesToStatsRows(mtTrades) : chartTradesToStatsRows(chartTrades)),
    [hasMtHistory, mtTrades, chartTrades],
  )

  const tradesByAccountId = useMemo(() => {
    const out: Record<string, ReturnType<typeof mtTradesToStatsRows>> = {}
    for (const t of mtTrades) {
      const rows = mtTradesToStatsRows([t])
      if (!rows[0]) continue
      const list = out[t.broker_id] ?? []
      list.push(rows[0])
      out[t.broker_id] = list
    }
    return out
  }, [mtTrades])

  const perAccountPerformance = useMemo(
    () => computeLinkedAccountPerformanceMap(accounts, tradesByAccountId, equityByAccountId),
    [accounts, tradesByAccountId, equityByAccountId],
  )

  const aggregate = useMemo(
    () => aggregateAccountPerformance(perAccountPerformance),
    [perAccountPerformance],
  )

  const periodStats = useCallback(
    (period: PerformancePeriod) =>
      chartTrades.length > 0
        ? computePeriodStatsFromChartTrades(chartTrades, period)
        : computePeriodTradeStats(statsRows, period),
    [chartTrades, statsRows],
  )

  const hasMtBrokers = accounts.some(isFxsocketLinkedBroker)

  const refreshBroker = useCallback(
    async (brokerId: string, opts?: { silent?: boolean }) => {
      if (!userId) return
      const account = payloadRef.current?.accounts.find(a => a.id === brokerId)
      if (!account || !isFxsocketLinkedBroker(account)) return

      if (!opts?.silent) {
        setRefreshing(true)
        setError(null)
      }

      try {
        const [summaryRes, brokerTrades] = await Promise.all([
          fxsocketBroker.refreshSummary(brokerId),
          fetchBrokerMtTrades({ scope: 'performance', brokerId, historyProfile: 'trades' }),
        ])

        const { account: refreshed, summary } = summaryRes
        const eq = summary?.equity ?? refreshed.last_equity ?? effectiveAccountSummaryBalance(summary)
        const bal = refreshed.last_balance ?? effectiveAccountSummaryBalance(summary) ?? summary?.equity
        const basePayload = payloadRef.current
        const priorTrades = basePayload?.mtTrades ?? mtTradesRef.current
        const nextAccounts = (basePayload?.accounts ?? []).map(a => {
          if (a.id !== brokerId) return a
          return { ...a, ...refreshed }
        })
        const mergedTrades = filterMtTradesSinceConnect(
          [
            ...priorTrades.filter(t => t.broker_id !== brokerId),
            ...brokerTrades,
          ],
          nextAccounts.length > 0 ? nextAccounts : basePayload?.accounts ?? [],
        )

        const nextEquity = {
          ...(basePayload?.equityByAccountId ?? {}),
          ...(eq != null && Number.isFinite(Number(eq)) ? { [brokerId]: Number(eq) } : {}),
        }
        const nextBalance = {
          ...(basePayload?.balanceByAccountId ?? {}),
          ...(bal != null && Number.isFinite(Number(bal)) ? { [brokerId]: Number(bal) } : {}),
        }

        const nextPayload: PerformanceCachePayload = {
          accounts: nextAccounts.length > 0 ? nextAccounts : basePayload?.accounts ?? [],
          mtTrades: mergedTrades,
          equityByAccountId: nextEquity,
          balanceByAccountId: nextBalance,
          channelLinkMaps: normalizeChannelLinkMaps(basePayload?.channelLinkMaps),
        }

        applyPayload(nextPayload)
        persistPayload(nextPayload)
        setLastUpdated(new Date())
      } catch (e) {
        if (!opts?.silent) {
          setError(e instanceof Error ? e.message : 'Failed to refresh broker')
        }
      } finally {
        if (!opts?.silent) setRefreshing(false)
      }
    },
    [userId, applyPayload, persistPayload],
  )

  return {
    accounts,
    mtTrades,
    chartTrades,
    hasMtHistory,
    hasMtBrokers,
    equityByAccountId,
    balanceByAccountId,
    channelLinkMaps,
    perAccountPerformance,
    aggregate,
    periodStats,
    loading,
    refreshing,
    error,
    lastUpdated,
    refresh: () => void load({ force: true }),
    refreshBroker,
  }
}
