import type { ForexNewsResponse } from './marketNewsTypes'
import { readSessionCache } from './sessionDataCache'

/** Align with edge function cache (~5 min). */
export const MARKET_NEWS_CACHE_TTL_MS = 5 * 60 * 1000

export function marketNewsCacheKey(options?: {
  page?: number
  limit?: number
  symbols?: string
}): string {
  const symbols = (options?.symbols ?? '').trim().toUpperCase() || 'all'
  const page = options?.page ?? 0
  const limit = options?.limit ?? 50
  return `market-news:${symbols}:${page}:${limit}`
}

export function peekMarketNewsCache(options?: {
  page?: number
  limit?: number
  symbols?: string
}): { response: ForexNewsResponse; fetchedAt: number } | null {
  const key = marketNewsCacheKey(options)
  const hit = readSessionCache<ForexNewsResponse>(key, MARKET_NEWS_CACHE_TTL_MS)
  if (!hit) return null
  return { response: hit.data, fetchedAt: hit.fetchedAt }
}
