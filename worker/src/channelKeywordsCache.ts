/**
 * In-memory cache for channel parse context (keywords + lexicon).
 * Shared by listener (hot path) and trade executor.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChannelKeywords, ChannelLexiconRow } from './parseSignal'
import {
  loadChannelKeywords,
  loadChannelLexicon,
} from './parseSignal'

const CACHE_TTL_MS = Math.max(
  60_000,
  Math.min(30 * 60_000, Number(process.env.CHANNEL_PARSE_CACHE_TTL_MS ?? 5 * 60_000)),
)

type CacheEntry = {
  keywords: ChannelKeywords
  lexicon: ChannelLexiconRow | null
  loadedAt: number
}

const cache = new Map<string, CacheEntry>()

export function invalidateChannelParseCache(channelId: string): void {
  cache.delete(channelId)
}

export async function getChannelParseContext(
  supabase: SupabaseClient,
  channelId: string,
): Promise<{ keywords: ChannelKeywords; lexicon: ChannelLexiconRow | null }> {
  const hit = cache.get(channelId)
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) {
    return { keywords: hit.keywords, lexicon: hit.lexicon }
  }
  const [keywords, lexicon] = await Promise.all([
    loadChannelKeywords(supabase, channelId),
    loadChannelLexicon(supabase, channelId),
  ])
  cache.set(channelId, { keywords, lexicon, loadedAt: Date.now() })
  return { keywords, lexicon }
}
