/** Site-wide logos — not article cover art. */
const GENERIC_IMAGE_RE =
  /\/(?:favicon|logo|icon|brand|sprite|avatar|placeholder|default-image|social-share)[^/]*\.(?:png|jpe?g|webp|gif|svg)/i

export function isUsableImage(url: string): boolean {
  const u = url.trim()
  if (!u.startsWith('http://') && !u.startsWith('https://')) return false
  if (GENERIC_IMAGE_RE.test(u)) return false
  if (/\/images\/(?:logo|favicon)/i.test(u)) return false
  return true
}

/** Use API-provided cover URL only — no shared favicon placeholder. */
export function resolveNewsImageUrl(article: { image: string }): string {
  return isUsableImage(article.image) ? article.image.trim() : ''
}
