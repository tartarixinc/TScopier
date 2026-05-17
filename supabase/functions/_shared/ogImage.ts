const OG_CACHE_TTL_MS = 60 * 60 * 1000
const ogCache = new Map<string, { expires: number; image: string }>()

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/** Site-wide logos / favicons — not article cover art. */
const GENERIC_IMAGE_RE =
  /\/(?:favicon|logo|icon|brand|sprite|avatar|placeholder|default-image|social-share)[^/]*\.(?:png|jpe?g|webp|gif|svg)/i

function normalizeImageUrl(raw: string, pageUrl: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed
  if (trimmed.startsWith("//")) return `https:${trimmed}`
  try {
    return new URL(trimmed, pageUrl).href
  } catch {
    return ""
  }
}

function isGenericSiteImage(url: string): boolean {
  if (!url) return true
  if (GENERIC_IMAGE_RE.test(url)) return true
  if (/\/images\/(?:logo|favicon)/i.test(url)) return true
  return false
}

function extractImagesFromHtml(html: string, pageUrl: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()

  const add = (raw: string) => {
    const url = normalizeImageUrl(raw, pageUrl)
    if (!url || seen.has(url) || isGenericSiteImage(url)) return
    seen.add(url)
    found.push(url)
  }

  const metaRe =
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = metaRe.exec(html)) !== null) add(m[1])

  const metaRe2 =
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi
  while ((m = metaRe2.exec(html)) !== null) add(m[1])

  const jsonLdRe = /"image"\s*:\s*"([^"]+)"/gi
  while ((m = jsonLdRe.exec(html)) !== null) add(m[1])

  const jsonLdObjRe = /"thumbnailUrl"\s*:\s*"([^"]+)"/gi
  while ((m = jsonLdObjRe.exec(html)) !== null) add(m[1])

  const featuredRe =
    /<img[^>]+(?:class|data-src)=["'][^"']*(?:featured|hero|article|post-thumbnail|wp-post-image)[^"']*["'][^>]+src=["']([^"']+)["']/gi
  while ((m = featuredRe.exec(html)) !== null) add(m[1])

  return found
}

/** Best-effort cover image from article page HTML. */
export async function fetchOgImage(pageUrl: string): Promise<string> {
  if (!pageUrl.startsWith("http")) return ""

  const cached = ogCache.get(pageUrl)
  if (cached && cached.expires > Date.now()) return cached.image

  let image = ""
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6_000)
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": BROWSER_UA,
      },
    })
    clearTimeout(timeout)
    if (!res.ok) {
      ogCache.set(pageUrl, { expires: Date.now() + OG_CACHE_TTL_MS, image: "" })
      return ""
    }
    const html = (await res.text()).slice(0, 200_000)
    image = extractImagesFromHtml(html, pageUrl)[0] ?? ""
  } catch {
    image = ""
  }

  ogCache.set(pageUrl, { expires: Date.now() + OG_CACHE_TTL_MS, image })
  return image
}

export function isUsableImage(url: string): boolean {
  const u = url.trim()
  return (u.startsWith("http://") || u.startsWith("https://")) && !isGenericSiteImage(u)
}

/** True when we should fetch a per-article cover (empty or shared digest logo). */
export function needsCoverImageFetch(image: string): boolean {
  return !isUsableImage(image)
}

export async function enrichArticlesWithOgImages<
  T extends { url: string; image: string },
>(articles: T[], maxFetches = 40, concurrency = 6): Promise<T[]> {
  const needs = articles
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => needsCoverImageFetch(a.image) && a.url.startsWith("http"))
    .slice(0, maxFetches)

  if (needs.length === 0) return articles

  const out = articles.map((a) => ({ ...a }))
  let cursor = 0

  async function worker() {
    while (cursor < needs.length) {
      const slot = cursor++
      const { a, index } = needs[slot]!
      const og = await fetchOgImage(a.url)
      if (og) out[index] = { ...out[index]!, image: og }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, needs.length) }, () => worker()))
  return out
}
