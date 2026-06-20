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

/** In-memory + sessionStorage so "Your Telegram channels" survives page revisits. */
const TTL_MS = 24 * 60 * 60 * 1000
const memory = new Map<string, CacheEntry>()

function storageKey(userId: string): string {
  return `tscopier:tg-channels:${userId}`
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt <= TTL_MS
}

function readStorage(userId: string): CacheEntry | null {
  try {
    const raw = sessionStorage.getItem(storageKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEntry
    if (!parsed || !Array.isArray(parsed.channels) || typeof parsed.fetchedAt !== 'number') {
      return null
    }
    if (!isFresh(parsed)) {
      sessionStorage.removeItem(storageKey(userId))
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeStorage(userId: string, entry: CacheEntry): void {
  try {
    sessionStorage.setItem(storageKey(userId), JSON.stringify(entry))
  } catch {
    /* ignore quota / private mode */
  }
}

export function getCachedTgChannels(userId: string): TgChannelListItem[] | null {
  const mem = memory.get(userId)
  if (mem && isFresh(mem)) return mem.channels

  const stored = readStorage(userId)
  if (stored) {
    memory.set(userId, stored)
    return stored.channels
  }

  if (mem) memory.delete(userId)
  return null
}

export function setCachedTgChannels(userId: string, channels: TgChannelListItem[]): void {
  const entry: CacheEntry = { channels, fetchedAt: Date.now() }
  memory.set(userId, entry)
  writeStorage(userId, entry)
}

export function invalidateTgChannelsCache(userId?: string): void {
  if (userId) {
    memory.delete(userId)
    try {
      sessionStorage.removeItem(storageKey(userId))
    } catch {
      /* ignore */
    }
    return
  }
  memory.clear()
}
