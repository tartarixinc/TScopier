import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getLocalCalendarDayBounds } from '../lib/dashboardTradeStats'
import { formatBrokerHistoryDate } from '../lib/mtApiDateTime'
import { fetchTradesAcrossProviders, type MtTrade } from '../lib/fxsocketBroker'
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
import {
  fetchTradesFromDatabase,
  recoverFromLiveFeedFailure,
} from '../lib/dbTradesFallback'
import {
  getLiveFeedGeneration,
  getLiveFeedStatus,
  isAuthSessionError,
  reportLiveFeedFailure,
  reportLiveFeedSuccess,
} from '../lib/liveFeedStatus'

const AUTO_REFRESH_MS = 15_000
const VISIBILITY_STALE_MS = 30_000

async function fetchTradesFromMt(userId: string): Promise<MtTrade[]> {
  const { tomorrowStart: historyTo } = getLocalCalendarDayBounds()
  const brokerRes = await supabase
    .from('broker_accounts')
    .select(BROKER_ACCOUNT_CLIENT_SELECT)
    .eq('user_id', userId)
  if (brokerRes.error) throw brokerRes.error
  const accounts = (brokerRes.data ?? []) as unknown as BrokerAccount[]

  const tradesRes = await fetchTradesAcrossProviders({
    scope: 'all',
    historyProfile: 'trades',
    historyFrom: BROKER_FULL_HISTORY_FROM,
    historyTo: formatBrokerHistoryDate(historyTo),
    accounts,
  })

  let normalized = enrichMtTradesTimestamps(tradesRes.trades ?? [])
  if (normalized.some(mtTradeMissingDisplayTime)) {
    const { trades: hydrated, stats } = await hydrateMtTradesTimesFromBrokers(normalized, accounts)
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
  // True while LIVE rows are on screen (session cache or last successful
  // read) — decides whether a failed refresh keeps them or falls back to
  // stored rows. Not keyed on this call's cache read: a forced refresh or an
  // expired TTL still has live rows on screen.
  const hasLiveRowsRef = useRef(false)

  const applyPayload = useCallback((payload: TradesCachePayload, fetchedAt: number) => {
    fingerprintRef.current = payload.fingerprint
    // Only real rows count: a successful read of an empty list must not stop
    // a later failure from falling back to stored rows.
    hasLiveRowsRef.current = payload.trades.length > 0
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
        // While the feed is degraded, skip the cache short-circuit so the
        // next real attempt can clear the banner as soon as the feed is back.
        if (
          !staleMissingTimes &&
          Date.now() - cached.fetchedAt < TRADES_CACHE_TTL_MS &&
          !getLiveFeedStatus().degraded
        ) {
          return
        }
      }

      inflightRef.current = true
      if (opts?.force || cached) setRefreshing(true)
      else setLoading(true)

      // Captured before the read: a partial provider failure raised inside
      // fetchTradesAcrossProviders must not be cleared by this read's
      // success — only a read that saw no newer failure may clear it.
      const feedGeneration = getLiveFeedGeneration()
      // The user (or session) may change while this read is in flight; a
      // completion for a previous user must not touch state or the cache.
      const startedForUser = userId
      try {
        const list = await fetchTradesFromMt(userId)
        if (hydratedUserRef.current !== startedForUser) return
        const fingerprint = tradesListFingerprint(list)
        const fetchedAt = Date.now()

        const payload: TradesCachePayload = { trades: list, fingerprint }
        writeSessionCache(key, payload)
        applyPayload(payload, fetchedAt)
        reportLiveFeedSuccess(feedGeneration)
      } catch (e) {
        if (hydratedUserRef.current !== startedForUser) return
        // Note: a failing broker_accounts read lands here too and would be
        // reported as feed trouble (its message is only kept for debugging;
        // the banner text itself never blames a specific vendor) — except
        // for auth-shaped errors, which are about our session, not the feed.
        const reason = e instanceof Error ? e.message : 'Failed to load trades'
        if (!isAuthSessionError(reason)) reportLiveFeedFailure(reason)
        await recoverFromLiveFeedFailure({
          reason,
          hasLiveRows: hasLiveRowsRef.current,
          readStoredTrades: () => fetchTradesFromDatabase(supabase, userId),
          keepLiveRows: () => {
            // Live rows already on screen are stale but real; the banner
            // explains the delay. Stored rows must never reach the session
            // cache — it holds live reads only.
          },
          applyStoredTrades: rows => {
            setTrades(rows)
            setError(null)
          },
          showReadError: message => {
            setTrades([])
            setError(message)
          },
        })
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
      hasLiveRowsRef.current = false
      setLoading(false)
      return
    }

    if (hydratedUserRef.current !== userId) {
      hydratedUserRef.current = userId
      // Any live rows on screen belong to the previous user.
      hasLiveRowsRef.current = false
      const key = tradesCacheKey(userId)
      const cached = readSessionCache<TradesCachePayload>(key, TRADES_CACHE_TTL_MS)
      if (cached) {
        applyPayload(cached.data, cached.fetchedAt)
        setLoading(false)
        const staleMissingTimes = cached.data.trades.some(mtTradeMissingDisplayTime)
        if (
          !staleMissingTimes &&
          Date.now() - cached.fetchedAt < TRADES_CACHE_TTL_MS &&
          !getLiveFeedStatus().degraded
        ) {
          return
        }
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
