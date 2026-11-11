/** Short-lived flag cookie so marketing can detect login from the app host. */
const AUTH_PRESENCE_COOKIE = 'tsc_auth'
const AUTH_PRESENCE_MAX_AGE_SEC = 60 * 60 * 24 * 30

export function getSharedAuthCookieDomain(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const host = window.location.hostname
  if (host === 'tscopier.ai' || host.endsWith('.tscopier.ai')) return '.tscopier.ai'
  if (host === 'unicopier.com' || host.endsWith('.unicopier.com')) return '.unicopier.com'
  return undefined
}

export function setAuthPresenceCookie(): void {
  const domain = getSharedAuthCookieDomain()
  if (!domain) return
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${AUTH_PRESENCE_COOKIE}=1; Domain=${domain}; Path=/; Max-Age=${AUTH_PRESENCE_MAX_AGE_SEC}; SameSite=Lax${secure}`
}

export function clearAuthPresenceCookie(): void {
  const domain = getSharedAuthCookieDomain()
  if (!domain) {
    document.cookie = `${AUTH_PRESENCE_COOKIE}=; Path=/; Max-Age=0`
    return
  }
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${AUTH_PRESENCE_COOKIE}=; Domain=${domain}; Path=/; Max-Age=0; SameSite=Lax${secure}`
}

export function hasAuthPresenceCookie(): boolean {
  if (typeof document === 'undefined') return false
  return document.cookie.split(';').some(chunk => chunk.trim() === `${AUTH_PRESENCE_COOKIE}=1`)
}
