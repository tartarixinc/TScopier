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
import { selectBrokerAccountColumns } from '../lib/brokerAccountSelect'
import { filterMtTradesSinceConnect } from '../lib/tradesSinceConnect'
import type { BrokerAccount } from '../types/database'

import { hasLinkedBrokerForUi, resolveProvider } from '../lib/brokerLink'

/** Default UI period is 30d — first paint only needs that window, not full 400d. */
const PERFORMANCE_CRITICAL_HISTORY_DAYS = 30
const PERFORMANCE_CRITICAL_MT_LIMIT = 3000
const PERFORMANCE_DB_TRADES_LIMIT = 800
const PERFORMANCE_ATTRIBUTIONS_LIMIT = 2000
const PERFORMANCE_SUMMARY_CONCURRENCY = 3

function hasStaleEmptyBrokerHistory(payload: PerformanceCachePayload): boolean {
  return payload.mtTrades.length === 0 && payload.accounts.some(hasLinkedBrokerForUi)
}

function equityBalanceFromCachedColumns(linked: BrokerAccount[]): {
  equity: Record<string, number>
  balance: Record<string, number>
} {
  const equity: Record<string, number> = {}
  const balance: Record<string, number> = {}
  for (const account of linked) {
    const eq = account.last_equity ?? account.last_balance
    const bal = account.last_balance ?? account.last_equity
    if (eq != null && Number.isFinite(Number(eq))) equity[account.id] = Number(eq)
    if (bal != null && Number.isFinite(Number(bal))) balance[account.id] = Number(bal)
  }
  return { equity, balance }
}

async function fetchPerformanceChannelMaps(userId: string) {
  const [channelsRes, dbTradesRes, attributionRes] = await Promise.all([
    supabase
      .from('telegram_channels')
      .select('id, display_name, channel_username')
      .eq('user_id', userId),
    supabase
      .from('trades')
      .select('broker_account_id, metaapi_order_id, signal_id, telegram_channel_id')
      .eq('user_id', userId)
      .order('opened_at', { ascending: false })
      .limit(PERFORMANCE_DB_TRADES_LIMIT),
    supabase
      .from('trade_channel_attributions')
      .select('broker_account_id, metaapi_order_id, signal_id, channel_id, channel_label')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(PERFORMANCE_ATTRIBUTIONS_LIMIT),
  ])

  const dbTrades = (dbTradesRes.data ?? []) as Array<{
    broker_account_id: string | null
    metaapi_order_id: string | null
    signal_id: string | null
    telegram_channel_id: string | null
  }>
  const signalIds = [...new Set(
    dbTrades
      .map(t => t.signal_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )]
  let signals: Array<{ id: string; channel_id: string | null }> = []
  if (signalIds.length > 0) {
    const chunkSize = 100
    const chunks: string[][] = []
    for (let i = 0; i < signalIds.length; i += chunkSize) {
      chunks.push(signalIds.slice(i, i + chunkSize))
    }
    const parts = await Promise.all(
      chunks.map(ids =>
        supabase.from('signals').select('id, channel_id').eq('user_id', userId).in('id', ids),
      ),
    )
    signals = parts.flatMap(part => (part.data ?? []) as Array<{ id: string; channel_id: string | null }>)
  }

  return buildPerformanceChannelLinkMaps(
    (channelsRes.data ?? []) as Array<{
      id: string
      display_name: string
      channel_username?: string | null
    }>,
    dbTrades,
    signals,
    (attributionRes.data ?? []) as Array<{
      broker_account_id: string | null
      metaapi_order_id: string | null
      signal_id: string | null
      channel_id: string | null
      channel_label: string | null
    }>,
  )
}

/** First paint: accounts + cached equity + 30d MT history + bounded channel maps. */
async function fetchPerformanceCriticalPayload(userId: string): Promise<PerformanceCachePayload> {
  const brokerRes = await selectBrokerAccountColumns(columns =>
    supabase
      .from('broker_accounts')
      .select(columns)
      .eq('user_id', userId),
  )
  if (brokerRes.error) throw brokerRes.error
  const linked = (brokerRes.data ?? []) as unknown as BrokerAccount[]
  const mtBrokers = linked.filter(hasLinkedBrokerForUi)
  const { equity, balance } = equityBalanceFromCachedColumns(linked)

  const [channelLinkMaps, trades] = await Promise.all([
    fetchPerformanceChannelMaps(userId),
    mtBrokers.length > 0
      ? fetchBrokerMtTrades({
          scope: 'performance',
          historyProfile: 'trades',
          historyDays: PERFORMANCE_CRITICAL_HISTORY_DAYS,
          limit: PERFORMANCE_CRITICAL_MT_LIMIT,
          accounts: linked,
        }).then(rows => filterMtTradesSinceConnect(rows, linked))
      : Promise.resolve([] as MtTrade[]),
  ])

  return {
    accounts: linked,
    mtTrades: trades,
    equityByAccountId: equity,
    balanceByAccountId: balance,
    channelLinkMaps,
  }
}

/** Background: full 400d history + live equity summaries (no 800ms sleeps). */
async function enrichPerformancePayload(
  userId: string,
  base: PerformanceCachePayload,
): Promise<PerformanceCachePayload> {
  const linked = base.accounts
  const mtBrokers = linked.filter(hasLinkedBrokerForUi)

  const fullHistoryPromise = mtBrokers.length > 0
    ? fetchBrokerMtTrades({
        scope: 'performance',
        historyProfile: 'trades',
        accounts: linked,
      }).then(rows => filterMtTradesSinceConnect(rows, linked))
    : Promise.resolve(base.mtTrades)

  const equity: Record<string, number> = { ...base.equityByAccountId }
  const balance: Record<string, number> = { ...base.balanceByAccountId }
  const baselineById: Record<string, number> = {}
  const toRefresh = linked.filter(hasLinkedBrokerForUi)

  for (let i = 0; i < toRefresh.length; i += PERFORMANCE_SUMMARY_CONCURRENCY) {
    const batch = toRefresh.slice(i, i + PERFORMANCE_SUMMARY_CONCURRENCY)
    await Promise.all(batch.map(async account => {
      try {
        const provider = resolveProvider(account)
        const { account: refreshed, summary } = await fxsocketBroker.refreshSummary(account.id, provider)
        const eq = summary?.equity ?? refreshed.last_equity ?? effectiveAccountSummaryBalance(summary) ?? refreshed.last_balance
        const bal = refreshed.last_balance ?? effectiveAccountSummaryBalance(summary) ?? refreshed.last_equity ?? summary?.equity
        if (eq != null && Number.isFinite(Number(eq))) equity[account.id] = Number(eq)
        if (bal != null && Number.isFinite(Number(bal))) balance[account.id] = Number(bal)
        const storedBaseline = refreshed.performance_baseline_balance ?? account.performance_baseline_balance
        if (storedBaseline != null && Number.isFinite(Number(storedBaseline)) && Number(storedBaseline) > 0) {
          baselineById[account.id] = Number(storedBaseline)
        }
      } catch {
        // Keep cached equity/balance from critical path.
      }
    }))
  }

  const [trades, channelLinkMaps] = await Promise.all([
    fullHistoryPromise,
    fetchPerformanceChannelMaps(userId),
  ])

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
        const critical = await fetchPerformanceCriticalPayload(userId)
        const fetchedAt = writeSessionCache(key, critical)
        applyPayload(critical)
        payloadRef.current = critical
        setLastUpdated(new Date(fetchedAt))
        setLoading(false)
        setRefreshing(false)

        // Enrichment: full history + live equity — never hold the skeleton.
        void enrichPerformancePayload(userId, critical).then(enriched => {
          if (hydratedUserRef.current !== userId) return
          const enrichAt = writeSessionCache(key, enriched)
          applyPayload(enriched)
          payloadRef.current = enriched
          setLastUpdated(new Date(enrichAt))
        }).catch(err => {
          console.warn('[performance] background enrich failed', err)
        })
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

  const hasMtBrokers = accounts.some(hasLinkedBrokerForUi)

  const refreshBroker = useCallback(
    async (brokerId: string, opts?: { silent?: boolean }) => {
      if (!userId) return
      const account = payloadRef.current?.accounts.find(a => a.id === brokerId)
      if (!account || !hasLinkedBrokerForUi(account)) return
      const provider = resolveProvider(account)

      if (!opts?.silent) {
        setRefreshing(true)
        setError(null)
      }

      try {
        const [summaryRes, brokerTrades] = await Promise.all([
          fxsocketBroker.refreshSummary(brokerId, provider),
          fetchBrokerMtTrades({
            scope: 'performance',
            brokerId,
            historyProfile: 'trades',
            providers: [provider],
          }),
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
