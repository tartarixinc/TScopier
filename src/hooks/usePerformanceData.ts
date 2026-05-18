import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildAccountGrowthSeries, mtTradeToChartRow } from '../lib/dashboardCharts'
import { computeLinkedAccountPerformanceMap } from '../lib/dashboardTradeStats'
import { metatraderApi, type MtTrade } from '../lib/metatraderapi'
import {
  aggregateAccountPerformance,
  chartTradesToStatsRows,
  computePeriodTradeStats,
  mtTradesToStatsRows,
  type PerformancePeriod,
} from '../lib/performanceAnalytics'
import type { BrokerAccount } from '../types/database'

export function usePerformanceData(userId: string | undefined) {
  const [accounts, setAccounts] = useState<BrokerAccount[]>([])
  const [mtTrades, setMtTrades] = useState<MtTrade[]>([])
  const [equityByAccountId, setEquityByAccountId] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const inflightRef = useRef(false)
  const mtTradesRef = useRef<MtTrade[]>([])

  const load = useCallback(
    async (isRefresh = false) => {
      if (!userId || inflightRef.current) return
      inflightRef.current = true
      if (isRefresh) setRefreshing(true)
      else setLoading(true)
      setError(null)
      try {
        const [brokerRes, tradesRes] = await Promise.all([
          supabase.from('broker_accounts').select('*').eq('user_id', userId).eq('is_active', true),
          metatraderApi.trades({ scope: 'all' }),
        ])
        if (brokerRes.error) throw brokerRes.error
        const linked = (brokerRes.data ?? []) as BrokerAccount[]
        setAccounts(linked)
        const incoming = tradesRes.trades ?? []
        if (incoming.length > 0) {
          mtTradesRef.current = incoming
          setMtTrades(incoming)
        } else if (!isRefresh || mtTradesRef.current.length === 0) {
          mtTradesRef.current = incoming
          setMtTrades(incoming)
        }

        const equity: Record<string, number> = {}
        await Promise.all(
          linked.map(async account => {
            try {
              const { summary } = await metatraderApi.summary(account.id)
              const eq = summary.equity ?? summary.balance
              if (eq != null && Number.isFinite(Number(eq))) {
                equity[account.id] = Number(eq)
              }
            } catch {
              const fallback = account.last_equity ?? account.last_balance
              if (fallback != null && Number.isFinite(Number(fallback))) {
                equity[account.id] = Number(fallback)
              }
            }
          }),
        )
        setEquityByAccountId(equity)
        setLastUpdated(new Date())
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load performance data')
      } finally {
        inflightRef.current = false
        setLoading(false)
        setRefreshing(false)
      }
    },
    [userId],
  )

  useEffect(() => {
    void load()
  }, [load])

  const chartTrades = useMemo(() => {
    if (mtTrades.length > 0) {
      return mtTrades.map(mtTradeToChartRow).filter((r): r is NonNullable<typeof r> => r != null)
    }
    return []
  }, [mtTrades])

  const statsRows = useMemo(
    () => (mtTrades.length > 0 ? mtTradesToStatsRows(mtTrades) : chartTradesToStatsRows(chartTrades)),
    [mtTrades, chartTrades],
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

  const accountGrowth = useMemo(
    () => buildAccountGrowthSeries(accounts, chartTrades, equityByAccountId),
    [accounts, chartTrades, equityByAccountId],
  )

  const periodStats = useCallback(
    (period: PerformancePeriod) => computePeriodTradeStats(statsRows, period),
    [statsRows],
  )

  return {
    accounts,
    chartTrades,
    equityByAccountId,
    perAccountPerformance,
    aggregate,
    accountGrowth,
    periodStats,
    loading,
    refreshing,
    error,
    lastUpdated,
    refresh: () => void load(true),
  }
}
