import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getLocalCalendarDayBounds } from '../lib/dashboardTradeStats'
import { formatBrokerHistoryDate } from '../lib/mtApiDateTime'
import { fetchTradesAcrossProviders, type MtTrade } from '../lib/fxsocketBroker'
import { selectBrokerAccountColumns } from '../lib/brokerAccountSelect'
import { filterMtTradesSinceConnect } from '../lib/tradesSinceConnect'
import type { BrokerAccount } from '../types/database'
import { BROKER_FULL_HISTORY_FROM } from '../lib/tradesConstants'
import { enrichMtTradesTimestamps, hydrateMtTradesTimesFromBrokers, mtTradeMissingDisplayTime } from '../lib/mtTradeTimestamps'
import { peekSessionCache, writeSessionCache } from '../lib/sessionDataCache'
import {
  TRADES_CACHE_TTL_MS,
  tradesCacheKey,
  tradesListFingerprint,
  type TradesCachePayload,
} from '../lib/tradesSessionCache'
import {
  TRADES_FULL_HISTORY_REFRESH_MS,
  incrementalHistoryFrom,
  mergeIncrementalTrades,
} from '../lib/tradesIncrementalHistory'
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
/** Retry broker timestamp hydration at most this often; it must not follow the 15s poll. */
const HYDRATION_BACKOFF_MS = 5 * 60 * 1000
/** Cap live MT history on first enrichment so cold load cannot wait on unbounded OrderHistory. */
const TRADES_LIVE_FETCH_LIMIT = 5000

type LiveTradesFetch = {
  trades: MtTrade[]
  accounts: BrokerAccount[]
  needsTimeHydration: boolean
}

async function fetchTradesFromMt(
  userId: string,
  historyFrom: string = BROKER_FULL_HISTORY_FROM,
): Promise<LiveTradesFetch> {
  const { tomorrowStart: historyTo } = getLocalCalendarDayBounds()
  const brokerRes = await selectBrokerAccountColumns(columns =>
    supabase
      .from('broker_accounts')
      .select(columns)
      .eq('user_id', userId),
  )
  if (brokerRes.error) throw brokerRes.error
  const accounts = (brokerRes.data ?? []) as unknown as BrokerAccount[]

  const tradesRes = await fetchTradesAcrossProviders({
    scope: 'all',
    historyProfile: 'trades',
    historyFrom,
    historyTo: formatBrokerHistoryDate(historyTo),
    accounts,
    limit: TRADES_LIVE_FETCH_LIMIT,
  })

  const normalized = enrichMtTradesTimestamps(tradesRes.trades ?? [])
  const trades = filterMtTradesSinceConnect(normalized, accounts)
  const needsTimeHydration = trades.some(mtTradeMissingDisplayTime)
  if (import.meta.env.DEV) {
    const missingFromEdge = normalized.filter(mtTradeMissingDisplayTime).length
    if (missingFromEdge > 0) {
      console.debug('[trades] missing times after fetch (hydrate in background)', {
        missing: missingFromEdge,
        total: normalized.length,
        sample: normalized.find(mtTradeMissingDisplayTime),
      })
    }
  }
  return { trades, accounts, needsTimeHydration }
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
  const lastHydrationAtRef = useRef(0)
  const loadSeqRef = useRef(0)

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
      const now = Date.now()
      // Peek at the long-lived entry first. A short-TTL read would evict it,
      // which used to turn every post-TTL refresh into a full history read.
      const historyCache = peekSessionCache<TradesCachePayload>(
        key,
        TRADES_FULL_HISTORY_REFRESH_MS,
      )
      const cached =
        !opts?.force && historyCache && now - historyCache.fetchedAt < TRADES_CACHE_TTL_MS
          ? historyCache
          : null

      if (cached) {
        // Deferred a microtask: when `load()` is called directly from an
        // effect, the effect body must not perform setState synchronously.
        // Relative order is preserved (this queues before the spinner write
        // and before anything the fetch path queues).
        void Promise.resolve().then(() => {
          applyPayload(cached.data, cached.fetchedAt)
          if (!opts?.background) setLoading(false)
        })
        // While the feed is degraded, skip the cache short-circuit so the
        // next real attempt can clear the banner as soon as the feed is back.
        if (
          now - cached.fetchedAt < TRADES_CACHE_TTL_MS &&
          !getLiveFeedStatus().degraded
        ) {
          return
        }
      }

      // Normal refreshes request only the recent window; the full history is
      // re-read once a day to drop deleted or corrected old rows.
      const fullHistoryAt = historyCache?.data.fullHistoryAt ?? historyCache?.fetchedAt ?? 0
      let historyFrom = BROKER_FULL_HISTORY_FROM
      let incrementalCache: TradesCachePayload | null = null
      if (
        historyCache &&
        now - fullHistoryAt < TRADES_FULL_HISTORY_REFRESH_MS &&
        !getLiveFeedStatus().degraded
      ) {
        incrementalCache = historyCache.data
        historyFrom = incrementalHistoryFrom(historyCache.data.trades, now)
      }

      // Only a load that actually fetches may invalidate an in-flight
      // hydration; a cache-hit poll must not cancel it (hydration would then
      // lose its 5-minute backoff slot and never land).
      const loadSeq = ++loadSeqRef.current
      inflightRef.current = true
      void Promise.resolve().then(() => {
        if (opts?.force || cached) setRefreshing(true)
        else setLoading(true)
      })

      // Captured before the read: a partial provider failure raised inside
      // fetchTradesAcrossProviders must not be cleared by this read's
      // success — only a read that saw no newer failure may clear it.
      const feedGeneration = getLiveFeedGeneration()
      // The user (or session) may change while this read is in flight; a
      // completion for a previous user must not touch state or the cache.
      const startedForUser = userId
      try {
        // Critical path: paint from DB so the skeleton is not tied to live MT history.
        if (!opts?.background && !cached) {
          try {
            const dbList = await fetchTradesFromDatabase(supabase, userId)
            if (hydratedUserRef.current === startedForUser && dbList.length > 0) {
              setTrades(dbList)
              setError(null)
              setLoading(false)
            }
          } catch {
            // Continue to live feed; failure recovery still handles empty screens.
          }
        }

        const live = await fetchTradesFromMt(userId, historyFrom)
        if (hydratedUserRef.current !== startedForUser) return
        // The edges only serve active accounts; cached rows from a disabled
        // account must not survive the merge.
        const accountIds = new Set(
          live.accounts.filter(account => account.is_active !== false).map(account => account.id),
        )
        const merged = filterMtTradesSinceConnect(
          incrementalCache
            ? mergeIncrementalTrades(live.trades, incrementalCache.trades, accountIds)
            : live.trades,
          live.accounts,
        )
        const fingerprint = tradesListFingerprint(merged)
        const fetchedAt = Date.now()

        const payload: TradesCachePayload = {
          trades: merged,
          fingerprint,
          fullHistoryAt: incrementalCache ? fullHistoryAt : fetchedAt,
        }
        writeSessionCache(key, payload)
        applyPayload(payload, fetchedAt)
        reportLiveFeedSuccess(feedGeneration)

        // Time hydration is bounded to the same window as the live read and
        // backs off, so it cannot turn the 15s poll back into full-history
        // reads. Older cached rows that still lack a time stay "—" until the
        // next daily full refresh.
        if (
          live.needsTimeHydration &&
          now - lastHydrationAtRef.current >= HYDRATION_BACKOFF_MS
        ) {
          lastHydrationAtRef.current = now
          void hydrateMtTradesTimesFromBrokers(live.trades, live.accounts, { historyFrom }).then(({ trades: hydrated, stats }) => {
            if (hydratedUserRef.current !== startedForUser) return
            if (loadSeqRef.current !== loadSeq) return
            if (import.meta.env.DEV && (stats.missingBefore > 0 || stats.historyErrors.length > 0)) {
              console.debug('[trades] time hydration fallback', stats)
            }
            const next = filterMtTradesSinceConnect(
              incrementalCache
                ? mergeIncrementalTrades(hydrated, incrementalCache.trades, accountIds)
                : hydrated,
              live.accounts,
            )
            const nextPayload: TradesCachePayload = {
              trades: next,
              fingerprint: tradesListFingerprint(next),
              fullHistoryAt: payload.fullHistoryAt,
            }
            writeSessionCache(key, nextPayload)
            applyPayload(nextPayload, Date.now())
          }).catch(err => {
            console.warn('[trades] background time hydration failed', err)
          })
        }
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
      lastHydrationAtRef.current = 0
      // No setLoading(false) here: ProtectedRoute only renders this hook
      // while a user exists, so userId only turns undefined on the way to
      // unmounting — a loading flag flip would never be observed.
      return
    }

    if (hydratedUserRef.current !== userId) {
      hydratedUserRef.current = userId
      // Any live rows on screen belong to the previous user.
      hasLiveRowsRef.current = false
      lastHydrationAtRef.current = 0
      const key = tradesCacheKey(userId)
      const cached = peekSessionCache<TradesCachePayload>(key, TRADES_CACHE_TTL_MS)
      if (cached) {
        // Hydration writes are deferred a microtask so the effect body
        // itself performs no setState; the decision below only reads the
        // cache entry, so nothing depends on them having run yet.
        void Promise.resolve().then(() => {
          applyPayload(cached.data, cached.fetchedAt)
          setLoading(false)
        })
        if (
          Date.now() - cached.fetchedAt < TRADES_CACHE_TTL_MS &&
          !getLiveFeedStatus().degraded
        ) {
          return
        }
        // Kicked through a promise callback: the effect body itself must not
        // call a state-setting function directly (react-hooks/set-state-in-effect).
        void Promise.resolve().then(() => load({ background: true }))
        return
      }
      // Deferred as well; `load()` below sets the same flag in its own
      // synchronous prefix, so this only covers the early-return edge.
      void Promise.resolve().then(() => setLoading(true))
    }

    void Promise.resolve().then(() => load())
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
