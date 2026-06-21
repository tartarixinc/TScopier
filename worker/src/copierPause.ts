import type { SupabaseClient } from '@supabase/supabase-js'

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { expiresAt: number; paused: boolean }>()
/** Signals with created_at before this timestamp are ignored after a resume (pause-window backlog). */
const resumedAtByUser = new Map<string, number>()

export function isUserCopierPausedCached(userId: string): boolean {
  const hit = cache.get(userId)
  if (hit && hit.expiresAt > Date.now()) return hit.paused
  return false
}

export function setUserCopierPausedCached(userId: string, paused: boolean): void {
  cache.set(userId, { paused, expiresAt: Date.now() + CACHE_TTL_MS })
}

export function invalidateCopierPauseCache(userId?: string): void {
  if (userId) {
    cache.delete(userId)
    return
  }
  cache.clear()
}

export async function loadCachedUserCopierPaused(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const hit = cache.get(userId)
  if (hit && hit.expiresAt > Date.now()) return hit.paused

  const { data, error } = await supabase
    .from('user_profiles')
    .select('copier_paused')
    .eq('user_id', userId)
    .maybeSingle()

  const paused = !error && data?.copier_paused === true
  cache.set(userId, { paused, expiresAt: Date.now() + CACHE_TTL_MS })
  return paused
}

/** Prime cache from a batch profile load (e.g. loadBrokers). */
export function primeCopierPauseCache(
  profiles: Array<{ user_id?: string; copier_paused?: boolean | null }>,
): void {
  for (const p of profiles) {
    const uid = String(p.user_id ?? '')
    if (!uid) continue
    setUserCopierPausedCached(uid, p.copier_paused === true)
  }
}

export function noteCopierPaused(userId: string): void {
  resumedAtByUser.delete(userId)
  setUserCopierPausedCached(userId, true)
}

export function noteCopierResumed(userId: string): void {
  resumedAtByUser.set(userId, Date.now())
  setUserCopierPausedCached(userId, false)
}

export function getCopierResumedAt(userId: string): number | null {
  return resumedAtByUser.get(userId) ?? null
}

export function signalPredatesCopierResume(
  userId: string,
  createdAt: string | null | undefined,
): boolean {
  const resumedAt = getCopierResumedAt(userId)
  if (resumedAt == null) return false
  const createdMs = Date.parse(String(createdAt ?? ''))
  if (!Number.isFinite(createdMs)) return false
  return createdMs < resumedAt
}

/** Apply a user_profiles copier_paused transition to in-memory worker state. */
export function applyCopierPauseProfileUpdate(
  userId: string,
  copierPaused: boolean,
  previousPaused?: boolean,
): 'paused' | 'resumed' | 'unchanged' {
  invalidateCopierPauseCache(userId)
  if (copierPaused) {
    if (previousPaused === true) {
      setUserCopierPausedCached(userId, true)
      return 'unchanged'
    }
    noteCopierPaused(userId)
    return 'paused'
  }
  if (previousPaused === true) {
    noteCopierResumed(userId)
    return 'resumed'
  }
  setUserCopierPausedCached(userId, false)
  return 'unchanged'
}
