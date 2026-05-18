export interface TgChannelListItem {
  id: string
  title: string
  username: string
  members_count: number
}

interface CacheEntry {
  channels: TgChannelListItem[]
  fetchedAt: number
}

const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()

export function getCachedTgChannels(userId: string): TgChannelListItem[] | null {
  const entry = cache.get(userId)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(userId)
    return null
  }
  return entry.channels
}

export function setCachedTgChannels(userId: string, channels: TgChannelListItem[]): void {
  cache.set(userId, { channels, fetchedAt: Date.now() })
}

export function invalidateTgChannelsCache(userId?: string): void {
  if (userId) cache.delete(userId)
  else cache.clear()
}
