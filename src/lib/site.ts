const DEFAULT_APP_ORIGIN = 'https://app.tscopier.ai'
const DEFAULT_MARKETING_ORIGIN = 'https://tscopier.ai'

function trimOrigin(raw: string | undefined, fallback: string): string {
  const v = raw?.trim()
  if (!v) return fallback
  return v.replace(/\/+$/, '')
}

export const APP_ORIGIN = trimOrigin(
  import.meta.env.VITE_APP_URL as string | undefined,
  DEFAULT_APP_ORIGIN,
)

export const MARKETING_ORIGIN = trimOrigin(
  import.meta.env.VITE_MARKETING_URL as string | undefined,
  DEFAULT_MARKETING_ORIGIN,
)

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function normalizePath(path: string): string {
  if (isAbsoluteHttpUrl(path)) return path
  if (!path || path === '/') return '/'
  return path.startsWith('/') ? path : `/${path}`
}

export function joinOrigin(origin: string, path: string): string {
  if (isAbsoluteHttpUrl(path)) return path
  const p = normalizePath(path)
  return p === '/' ? origin : `${origin}${p}`
}

function isLocalDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')
}

/** Append or replace `site=` for local dual-shell navigation (same Vite origin). */
function withDevSite(path: string, site: 'app' | 'marketing'): string {
  const normalized = normalizePath(path)
  const url = new URL(normalized, 'http://local.invalid')
  url.searchParams.set('site', site)
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * Merge extra query params into a path that may already include a query string.
 * Avoids broken URLs like `/pricing?site=marketing?ref=x`.
 */
export function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const absolute = isAbsoluteHttpUrl(path)
  const url = absolute ? new URL(path) : new URL(normalizePath(path), 'http://local.invalid')
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue
    url.searchParams.set(key, value)
  }
  if (absolute) return url.toString()
  return `${url.pathname}${url.search}${url.hash}`
}

function isLocalBrowser(): boolean {
  return typeof window !== 'undefined' && isLocalDevHost(window.location.hostname)
}

/**
 * Absolute origin for the product app (Stripe success URLs, etc.).
 * On localhost always use the current origin so checkout does not bounce to prod.
 */
export function appAbsoluteOrigin(): string {
  if (isLocalBrowser()) return window.location.origin
  return APP_ORIGIN
}

export function appAbsoluteUrl(path = '/'): string {
  if (isLocalBrowser()) {
    // Keep site=app so Stripe success remounts the product shell, not marketing.
    const localPath = appUrl(path)
    return `${window.location.origin}${localPath}`
  }
  return joinOrigin(APP_ORIGIN, normalizePath(path))
}

export function appUrl(path = '/'): string {
  if (typeof window !== 'undefined' && isLocalDevHost(window.location.hostname)) {
    // Always pin site=app so a full reload does not flip back to marketing via VITE_DEV_SITE.
    return withDevSite(path, 'app')
  }
  if (typeof window !== 'undefined' && isAppHost()) {
    return normalizePath(path)
  }
  return joinOrigin(APP_ORIGIN, path)
}

export function marketingUrl(path = '/'): string {
  if (typeof window !== 'undefined' && isLocalDevHost(window.location.hostname)) {
    // Always pin site=marketing so /pricing does not remount the auth-gated app shell.
    return withDevSite(path, 'marketing')
  }
  if (typeof window !== 'undefined' && !isAppHost()) {
    return normalizePath(path)
  }
  return joinOrigin(MARKETING_ORIGIN, path)
}

function devSiteOverride(): 'app' | 'marketing' | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const q = params.get('site')
  if (q === 'marketing' || q === 'app') return q
  const env = (import.meta.env.VITE_DEV_SITE as string | undefined)?.trim().toLowerCase()
  if (env === 'marketing' || env === 'app') return env
  return null
}

function isMarketingHost(hostname: string): boolean {
  if (hostname === 'tscopier.ai' || hostname === 'www.tscopier.ai') return true
  if (hostname === 'unicopier.com' || hostname === 'www.unicopier.com') return true
  if (hostname.endsWith('.netlify.app')) return true
  return false
}

/** True when the product app (dashboard, auth, pricing) should mount. */
export function isAppHost(hostname = window.location.hostname): boolean {
  const override = devSiteOverride()
  if (override) return override === 'app'

  if (hostname === 'app.tscopier.ai') return true
  if (hostname === 'app.unicopier.com') return true
  if (hostname === 'staging.tscopier.ai') return true
  if (hostname === 'migration.tscopier.ai') return true
  if (hostname === 'legendary-valkyrie-4da363.netlify.app') return true
  if (isMarketingHost(hostname)) return false
  if (isLocalDevHost(hostname)) return true
  if (hostname.startsWith('app.')) return true
  // Same Netlify deploy serves both hosts — unknown host defaults to marketing.
  return false
}
