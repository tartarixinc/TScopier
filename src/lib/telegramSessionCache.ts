/** In-memory + sessionStorage hint so Channels page does not flash "Connect Telegram" while loading. */

const memory = new Map<string, boolean>()

function storageKey(userId: string) {
  return `tscopier:tg-session:${userId}`
}

export function getCachedTgSession(userId: string): boolean | null {
  const mem = memory.get(userId)
  if (mem !== undefined) return mem
  try {
    const raw = sessionStorage.getItem(storageKey(userId))
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    /* ignore */
  }
  return null
}

export function setCachedTgSession(userId: string, connected: boolean): void {
  memory.set(userId, connected)
  try {
    sessionStorage.setItem(storageKey(userId), connected ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function invalidateTgSessionCache(userId?: string): void {
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
