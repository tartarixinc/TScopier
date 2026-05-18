export const DASHBOARD_CACHE_VERSION = 'dashboard_cache_v10'
export const DASHBOARD_CACHE_LEGACY_KEYS = ['dashboard_cache_v9', 'dashboard_cache_v8', 'dashboard_cache_v7'] as const
export const DASHBOARD_ACTIVE_USER_KEY = 'dashboard_cache_active_user_id'

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
}
