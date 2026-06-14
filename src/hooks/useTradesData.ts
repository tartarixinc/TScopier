import { useCallback, useEffect, useRef, useState } from 'react'
import { getLocalCalendarDayBounds } from '../lib/dashboardTradeStats'
import { formatLocalMtApiDateTime } from '../lib/mtApiDateTime'
import { fxsocketBroker, type MtTrade } from '../lib/fxsocketBroker'
import { TRADES_PAGE_HISTORY_DAYS, TRADES_PAGE_MAX_RESULTS } from '../lib/tradesConstants'
import {
  enrichMtTradesTimestamps,
  hydrateMtTradesTimesFromBrokers,
  mtTradeMissingDisplayTime,
} from '../lib/mtTradeTimestamps'
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
/** Max rows returned for the Account Trades page (newest first). */
export { TRADES_PAGE_MAX_RESULTS, TRADES_PAGE_HISTORY_DAYS } from '../lib/tradesConstants'

async function fetchTradesFromMt(): Promise<MtTrade[]> {
  const { tomorrowStart: historyTo } = getLocalCalendarDayBounds()
  const historyFrom = new Date()
  historyFrom.setDate(historyFrom.getDate() - TRADES_PAGE_HISTORY_DAYS)
  const res = await fxsocketBroker.trades({
    scope: 'all',
    historyProfile: 'trades',
    historyFrom: formatLocalMtApiDateTime(historyFrom),
    historyTo: formatLocalMtApiDateTime(historyTo),
    limit: TRADES_PAGE_MAX_RESULTS,
  })
  const normalized = enrichMtTradesTimestamps(
    (res.trades ?? []).slice(0, TRADES_PAGE_MAX_RESULTS),
  )
  return hydrateMtTradesTimesFromBrokers(normalized)
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
        const list = await fetchTradesFromMt()
        const fingerprint = tradesListFingerprint(list)
        const fetchedAt = Date.now()

        const payload: TradesCachePayload = { trades: list, fingerprint }
        if (fingerprint !== fingerprintRef.current) {
          writeSessionCache(key, payload)
          applyPayload(payload, fetchedAt)
        } else {
          writeSessionCache(key, payload)
          setLastSyncedAt(fetchedAt)
        }
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
