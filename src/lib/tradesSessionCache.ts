import { clearSessionCacheKey, readSessionCache } from './sessionDataCache'
import type { MtTrade } from './fxsocketBroker'

/** Serve Trades page from cache; background refetch when older than this. */
export const TRADES_CACHE_TTL_MS = 90 * 1000

export type TradesCachePayload = {
  trades: MtTrade[]
  fingerprint: string
}

export function tradesCacheKey(userId: string): string {
  return `trades:v13:${userId}`
}

/** Cheap signature so we can skip re-renders when MT data is unchanged. */
export function tradesListFingerprint(trades: MtTrade[]): string {
  if (!trades.length) return '0'
  let open = 0
  let maxTs = 0
  for (const t of trades) {
    if (t.status === 'open') open += 1
    const raw = t.status === 'closed' ? (t.closed_at ?? t.opened_at) : t.opened_at
    const ts = raw ? Date.parse(raw) : 0
    if (Number.isFinite(ts) && ts > maxTs) maxTs = ts
  }
  return `${trades.length}:${open}:${maxTs}`
}

/** Open-leg count from cached Trades page data; null if no fresh cache. */
export function openTradeCountInCache(userId: string): number | null {
  const cached = readSessionCache<TradesCachePayload>(tradesCacheKey(userId), TRADES_CACHE_TTL_MS)
  if (!cached) return null
  return cached.data.trades.filter(t => t.status === 'open').length
}

export function clearTradesSessionCache(userId?: string | null): void {
  if (!userId) return
  clearSessionCacheKey(tradesCacheKey(userId))
}
