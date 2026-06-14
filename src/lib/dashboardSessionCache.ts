export const DASHBOARD_CACHE_VERSION = 'dashboard_cache_v18'
export const DASHBOARD_CACHE_LEGACY_KEYS = ['dashboard_cache_v17', 'dashboard_cache_v16', 'dashboard_cache_v15', 'dashboard_cache_v11', 'dashboard_cache_v10', 'dashboard_cache_v9', 'dashboard_cache_v8', 'dashboard_cache_v7'] as const
export const DASHBOARD_ACTIVE_USER_KEY = 'dashboard_cache_active_user_id'

export type DashboardCacheTimestamps = {
  cachedAt?: number
  cachedDay?: string
}

/** In-memory snapshot — survives DashboardPage unmount/remount within the same tab. */
let dashboardMemoryCache: { userId: string; payload: unknown } | null = null

/** In-memory: dashboard data was loaded or restored this browser tab session. */
let dashboardSessionLoadedUserId: string | null = null
let dashboardActiveUserId: string | null = null

export function readDashboardMemoryCache<T>(userId: string): T | null {
  if (dashboardMemoryCache?.userId !== userId) return null
  return dashboardMemoryCache.payload as T
}

export function writeDashboardMemoryCache(userId: string, payload: unknown): void {
  dashboardMemoryCache = { userId, payload }
}

export function markDashboardSessionLoaded(userId: string): void {
  dashboardSessionLoadedUserId = userId
}

export function isDashboardSessionLoaded(userId: string): boolean {
  return dashboardSessionLoadedUserId === userId
}

export function getDashboardActiveUserId(): string | null {
  return dashboardActiveUserId
}

export function setDashboardActiveUserId(userId: string | null): void {
  dashboardActiveUserId = userId
}

/** Resolve the user id used for dashboard cache reads before auth has hydrated. */
export function resolveDashboardCacheUserId(authUserId?: string | null): string | null {
  if (authUserId) return authUserId
  if (typeof sessionStorage === 'undefined') return null
  return sessionStorage.getItem(DASHBOARD_ACTIVE_USER_KEY)
}

/** Clear per-user dashboard session cache (call on sign-out or user switch). */
export function clearDashboardSessionCache(userId?: string | null) {
  if (typeof sessionStorage === 'undefined') return
  const ids = new Set<string>()
  if (userId) ids.add(userId)
  const active = sessionStorage.getItem(DASHBOARD_ACTIVE_USER_KEY)
  if (active) ids.add(active)
  for (const id of ids) {
    sessionStorage.removeItem(`${DASHBOARD_CACHE_VERSION}:${id}`)
    for (const legacy of DASHBOARD_CACHE_LEGACY_KEYS) {
      sessionStorage.removeItem(`${legacy}:${id}`)
    }
  }
  sessionStorage.removeItem(DASHBOARD_ACTIVE_USER_KEY)
  dashboardSessionLoadedUserId = null
  dashboardActiveUserId = null
  if (!userId || dashboardMemoryCache?.userId === userId) {
    dashboardMemoryCache = null
  }
}
