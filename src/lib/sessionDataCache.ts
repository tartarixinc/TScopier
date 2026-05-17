const STORAGE_PREFIX = 'tscopier:data:'

interface CacheEnvelope<T> {
  data: T
  fetchedAt: number
}

const memory = new Map<string, CacheEnvelope<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`
}

export function readSessionCache<T>(key: string, ttlMs: number): { data: T; fetchedAt: number } | null {
  const now = Date.now()
  const mem = memory.get(key) as CacheEnvelope<T> | undefined
  if (mem && now - mem.fetchedAt < ttlMs) {
    return { data: mem.data, fetchedAt: mem.fetchedAt }
  }

  try {
    const raw = sessionStorage.getItem(storageKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEnvelope<T>
    if (!parsed?.data || typeof parsed.fetchedAt !== 'number') return null
    if (now - parsed.fetchedAt >= ttlMs) {
      sessionStorage.removeItem(storageKey(key))
      memory.delete(key)
      return null
    }
    memory.set(key, parsed)
    return { data: parsed.data, fetchedAt: parsed.fetchedAt }
  } catch {
    return null
  }
}

export function writeSessionCache<T>(key: string, data: T): number {
  const fetchedAt = Date.now()
  const envelope: CacheEnvelope<T> = { data, fetchedAt }
  memory.set(key, envelope as CacheEnvelope<unknown>)
  try {
    sessionStorage.setItem(storageKey(key), JSON.stringify(envelope))
  } catch {
    // Quota exceeded — memory cache still works for this session.
  }
  return fetchedAt
}

export async function fetchWithSessionCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  options?: { forceRefresh?: boolean },
): Promise<{ data: T; fetchedAt: number; fromCache: boolean }> {
  if (!options?.forceRefresh) {
    const cached = readSessionCache<T>(key, ttlMs)
    if (cached) return { ...cached, fromCache: true }
  }

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending && !options?.forceRefresh) {
    const data = await pending
    const hit = readSessionCache<T>(key, ttlMs)
    return { data, fetchedAt: hit?.fetchedAt ?? Date.now(), fromCache: true }
  }

  const run = fetcher()
    .then((data) => {
      const fetchedAt = writeSessionCache(key, data)
      return { data, fetchedAt, fromCache: false as const }
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, run.then((r) => r.data))
  return run
}
