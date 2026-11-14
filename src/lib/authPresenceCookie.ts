/** Cross-subdomain hint so marketing can detect login from the app host. */
const AUTH_PRESENCE_COOKIE = 'tsc_auth'
/** Public avatar URL + initials for the marketing header (no secrets). */
const AUTH_AVATAR_COOKIE = 'tsc_auth_avatar'
const AUTH_PRESENCE_MAX_AGE_SEC = 60 * 60 * 24 * 30
/** Stay well under typical ~4KB cookie limits. */
const AUTH_AVATAR_MAX_CHARS = 2800

export type AuthPresenceAvatar = {
  url: string | null
  initials: string | null
}

export function getSharedAuthCookieDomain(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const host = window.location.hostname
  if (host === 'tscopier.ai' || host.endsWith('.tscopier.ai')) return '.tscopier.ai'
  if (host === 'unicopier.com' || host.endsWith('.unicopier.com')) return '.unicopier.com'
  return undefined
}

function cookieSecureFlag(): string {
  return window.location.protocol === 'https:' ? '; Secure' : ''
}

function writeSharedCookie(name: string, value: string, maxAgeSec: number): void {
  const domain = getSharedAuthCookieDomain()
  if (!domain) return
  document.cookie =
    `${name}=${value}; Domain=${domain}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${cookieSecureFlag()}`
}

function clearSharedCookie(name: string): void {
  const domain = getSharedAuthCookieDomain()
  if (!domain) {
    document.cookie = `${name}=; Path=/; Max-Age=0`
    return
  }
  document.cookie =
    `${name}=; Domain=${domain}; Path=/; Max-Age=0; SameSite=Lax${cookieSecureFlag()}`
}

function readCookieValue(name: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${name}=`
  for (const chunk of document.cookie.split(';')) {
    const part = chunk.trim()
    if (part.startsWith(prefix)) return part.slice(prefix.length)
  }
  return null
}

export function setAuthPresenceCookie(): void {
  writeSharedCookie(AUTH_PRESENCE_COOKIE, '1', AUTH_PRESENCE_MAX_AGE_SEC)
}

export function clearAuthPresenceCookie(): void {
  clearSharedCookie(AUTH_PRESENCE_COOKIE)
  clearAuthPresenceAvatarCookie()
}

export function hasAuthPresenceCookie(): boolean {
  return readCookieValue(AUTH_PRESENCE_COOKIE) === '1'
}

/** Store a public avatar hint for the marketing header on the sibling marketing host. */
export function setAuthPresenceAvatarCookie(avatar: AuthPresenceAvatar): void {
  if (!getSharedAuthCookieDomain()) return
  const payload: AuthPresenceAvatar = {
    url: avatar.url?.trim() || null,
    initials: avatar.initials?.trim().slice(0, 3) || null,
  }
  if (!payload.url && !payload.initials) {
    clearAuthPresenceAvatarCookie()
    return
  }
  const encoded = encodeURIComponent(JSON.stringify(payload))
  if (encoded.length > AUTH_AVATAR_MAX_CHARS) {
    // Prefer initials over a truncated URL.
    const fallback = encodeURIComponent(JSON.stringify({ url: null, initials: payload.initials }))
    writeSharedCookie(AUTH_AVATAR_COOKIE, fallback, AUTH_PRESENCE_MAX_AGE_SEC)
    return
  }
  writeSharedCookie(AUTH_AVATAR_COOKIE, encoded, AUTH_PRESENCE_MAX_AGE_SEC)
}

export function clearAuthPresenceAvatarCookie(): void {
  clearSharedCookie(AUTH_AVATAR_COOKIE)
}

export function readAuthPresenceAvatarCookie(): AuthPresenceAvatar | null {
  const raw = readCookieValue(AUTH_AVATAR_COOKIE)
  if (!raw) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<AuthPresenceAvatar>
    const url = typeof parsed.url === 'string' && parsed.url.trim() ? parsed.url.trim() : null
    const initials =
      typeof parsed.initials === 'string' && parsed.initials.trim()
        ? parsed.initials.trim().slice(0, 3)
        : null
    if (!url && !initials) return null
    return { url, initials }
  } catch {
    return null
  }
}
