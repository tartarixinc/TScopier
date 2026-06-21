import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getLocalCalendarDayBounds } from '../lib/dashboardTradeStats'
import { formatBrokerHistoryDate } from '../lib/mtApiDateTime'
import { fxsocketBroker, type MtTrade } from '../lib/fxsocketBroker'
import { BROKER_ACCOUNT_CLIENT_SELECT } from '../lib/brokerAccountSelect'
import { filterMtTradesSinceConnect } from '../lib/tradesSinceConnect'
import type { BrokerAccount } from '../types/database'
import { BROKER_FULL_HISTORY_FROM } from '../lib/tradesConstants'
import { enrichMtTradesTimestamps, hydrateMtTradesTimesFromBrokers, mtTradeMissingDisplayTime } from '../lib/mtTradeTimestamps'
import { readSessionCache, writeSessionCache } from '../lib/sessionDataCache'
import {
  TRADES_CACHE_TTL_MS,
  tradesCacheKey,
  tradesListFingerprint,
  type TradesCachePayload,
} from '../lib/tradesSessionCache'
import { useDashboardRealtime } from './useDashboardRealtime'

const AUTO_REFRESH_MS = 15_000
const VISIBILITY_STALE_MS = 30_000

async function fetchTradesFromMt(userId: string): Promise<MtTrade[]> {
  const { tomorrowStart: historyTo } = getLocalCalendarDayBounds()
  const [tradesRes, brokerRes] = await Promise.all([
    fxsocketBroker.trades({
      scope: 'all',
      historyProfile: 'trades',
      historyFrom: BROKER_FULL_HISTORY_FROM,
      historyTo: formatBrokerHistoryDate(historyTo),
    }),
    supabase
      .from('broker_accounts')
      .select(BROKER_ACCOUNT_CLIENT_SELECT)
      .eq('user_id', userId),
  ])
  if (brokerRes.error) throw brokerRes.error

  let normalized = enrichMtTradesTimestamps(tradesRes.trades ?? [])
  if (normalized.some(mtTradeMissingDisplayTime)) {
    const { trades: hydrated, stats } = await hydrateMtTradesTimesFromBrokers(normalized)
    normalized = hydrated
    if (import.meta.env.DEV && (stats.missingBefore > 0 || stats.historyErrors.length > 0)) {
      console.debug('[trades] time hydration fallback', stats)
    }
  }
  if (import.meta.env.DEV) {
    const missingFromEdge = normalized.filter(mtTradeMissingDisplayTime).length
    if (missingFromEdge > 0) {
      console.debug('[trades] missing times after fetch', {
        missing: missingFromEdge,
        total: normalized.length,
        sample: normalized.find(mtTradeMissingDisplayTime),
      })
    }
  }
  const accounts = (brokerRes.data ?? []) as unknown as BrokerAccount[]
  return filterMtTradesSinceConnect(normalized, accounts)
}

export function useTradesData(userId: string | undefined) {
  const [trades, setTrades] = useState<MtTrade[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)

  const inflightRef = useRef(false)
  const fingerprintRef = useRef<string>('')
  const hydratedUserRef = useRef<string | null>(null)

  const applyPayload = useCallback((payload: TradesCachePayload, fetchedAt: number) => {
    fingerprintRef.current = payload.fingerprint
    setTrades(payload.trades)
    setLastSyncedAt(fetchedAt)
    setError(null)
  }, [])

  const load = useCallback(
    async (opts?: { force?: boolean; background?: boolean }) => {
      if (!userId || inflightRef.current) return

      const key = tradesCacheKey(userId)
      const cached =
        !opts?.force ? readSessionCache<TradesCachePayload>(key, TRADES_CACHE_TTL_MS) : null

      if (cached && !opts?.force) {
        applyPayload(cached.data, cached.fetchedAt)
        if (!opts?.background) setLoading(false)
        const staleMissingTimes = cached.data.trades.some(mtTradeMissingDisplayTime)
        if (!staleMissingTimes && Date.now() - cached.fetchedAt < TRADES_CACHE_TTL_MS) return
      }

      inflightRef.current = true
      if (opts?.force || cached) setRefreshing(true)
      else setLoading(true)

      try {
        const list = await fetchTradesFromMt(userId)
        const fingerprint = tradesListFingerprint(list)
        const fetchedAt = Date.now()

        const payload: TradesCachePayload = { trades: list, fingerprint }
        writeSessionCache(key, payload)
        applyPayload(payload, fetchedAt)
      } catch (e) {
        if (!cached) {
          setTrades([])
          setError(e instanceof Error ? e.message : 'Failed to load trades')
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
      const key = tradesCacheKey(userId)
      const cached = readSessionCache<TradesCachePayload>(key, TRADES_CACHE_TTL_MS)
      if (cached) {
        applyPayload(cached.data, cached.fetchedAt)
        setLoading(false)
        const staleMissingTimes = cached.data.trades.some(mtTradeMissingDisplayTime)
        if (!staleMissingTimes && Date.now() - cached.fetchedAt < TRADES_CACHE_TTL_MS) return
        void load({ background: true })
        return
      }
      setLoading(true)
    }

    void load()
  }, [userId, load, applyPayload])

  useEffect(() => {
    if (!userId) return
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void load({ background: true })
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(interval)
  }, [userId, load])

  useEffect(() => {
    if (!userId) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const stale =
        lastSyncedAt == null || Date.now() - lastSyncedAt > VISIBILITY_STALE_MS
      if (stale) void load({ background: true, force: true })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [userId, load, lastSyncedAt])

  useDashboardRealtime(userId, () => {
    void load({ background: true, force: true })
  })

  return {
    trades,
    loading,
    refreshing,
    error,
    lastSyncedAt,
    refresh: () => void load({ force: true }),
  }
}
