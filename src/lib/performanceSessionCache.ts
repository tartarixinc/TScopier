import { clearSessionCacheKey } from './sessionDataCache'
import type { MtTrade } from './metatraderapi'
import type { BrokerAccount } from '../types/database'

/** How long Performance page data is served from cache without refetching. */
export const PERFORMANCE_CACHE_TTL_MS = 5 * 60 * 1000

export type PerformanceCachePayload = {
  accounts: BrokerAccount[]
  mtTrades: MtTrade[]
  equityByAccountId: Record<string, number>
  balanceByAccountId: Record<string, number>
}

export function performanceCacheKey(userId: string): string {
  return `performance:v1:${userId}`
}

export function clearPerformanceSessionCache(userId?: string | null): void {
  if (!userId) return
  clearSessionCacheKey(performanceCacheKey(userId))
}
