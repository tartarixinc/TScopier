const STORAGE_KEY = 'tsc_post_auth_redirect'
/** Long enough to cover email confirmation in another tab. */
export const POST_AUTH_REDIRECT_TTL_MS = 60 * 60 * 1000

type Stored = { path: string; at: number }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Only same-app absolute paths are allowed (no protocol-relative or external URLs). */
export function isSafeInternalPath(path: string): boolean {
  return typeof path === 'string'
    && path.startsWith('/')
    && !path.startsWith('//')
    && !path.includes('\\')
    && ![...path].some(char => char.charCodeAt(0) < 32)
}

/** Remember where to send the visitor after they sign up or log in. */
export function stashPostAuthRedirect(path: string, now: number = Date.now()): boolean {
  const store = storage()
  if (!store || !isSafeInternalPath(path)) return false
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ path, at: now } satisfies Stored))
    return true
  } catch {
    return false
  }
}

export function clearPostAuthRedirect(): void {
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** Read the pending redirect without clearing it (expired or invalid values are dropped). */
export function peekPostAuthRedirect(now: number = Date.now()): string | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Stored>
    if (
      typeof parsed.path !== 'string'
      || typeof parsed.at !== 'number'
      || !isSafeInternalPath(parsed.path)
      || now - parsed.at > POST_AUTH_REDIRECT_TTL_MS
      || parsed.at > now + 60_000
    ) {
      store.removeItem(STORAGE_KEY)
      return null
    }
    return parsed.path
  } catch {
    clearPostAuthRedirect()
    return null
  }
}

/** Read and clear the pending redirect. */
export function consumePostAuthRedirect(now: number = Date.now()): string | null {
  const path = peekPostAuthRedirect(now)
  if (path) clearPostAuthRedirect()
  return path
}

/** Where a visitor on a provider's public page should land after authenticating. */
export function providerCopyLandingPath(providerUserId: string): string {
  return `/social-trading/${encodeURIComponent(providerUserId)}?copy=1`
}

/** Read `?next=` (set by links that cross from the marketing site to the app) and remember it on this origin. */
export function capturePostAuthRedirectFromUrl(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  const next = params.get('next')?.trim()
  if (!next || !isSafeInternalPath(next)) return null
  return stashPostAuthRedirect(next) ? next : null
}
