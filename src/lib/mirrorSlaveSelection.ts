/**
 * The Mirror Trading page keeps slave membership in localStorage, because a
 * broker can be added as a slave before any copy link exists. That makes
 * "remove this slave" a two-part operation: delete the links and drop the id.
 *
 * Every path that removes a destination link must use these helpers. When the
 * id was only dropped by the Mirror page itself, removing a slave from the
 * Configurations page left the stored id behind and the slave came back on the
 * next load.
 */
const SLAVE_KEY = 'tscopier:mirror-trading:slaves:'

function storageKey(userId: string): string {
  return `${SLAVE_KEY}${userId}`
}

export function readMirrorSlaveIds(userId: string | null | undefined): string[] {
  if (!userId) return []
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

export function writeMirrorSlaveIds(userId: string | null | undefined, ids: string[]): void {
  if (!userId) return
  try {
    if (ids.length === 0) localStorage.removeItem(storageKey(userId))
    else localStorage.setItem(storageKey(userId), JSON.stringify(ids))
  } catch {
    // A full quota must not block the account change itself.
  }
}

/** Drop one broker from the stored slave list; safe to call when it is absent. */
export function removeMirrorSlaveId(userId: string | null | undefined, brokerId: string): void {
  if (!userId || !brokerId) return
  const current = readMirrorSlaveIds(userId)
  if (!current.includes(brokerId)) return
  writeMirrorSlaveIds(userId, current.filter(id => id !== brokerId))
}
