/** Decode common HTML entities after tag stripping. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, '')
}

const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
const IMG_SRC_RE = /<img\b[^>]+src=["']([^"']+)["']/i
const LI_RE = /<li\b[^>]*>([\s\S]*?)<\/li>/gi

export interface HtmlNewsLink {
  href: string
  text: string
  image?: string
}

function normalizeImgSrc(src: string, baseUrl?: string): string {
  const trimmed = src.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (baseUrl) {
    try {
      return new URL(trimmed, baseUrl).href
    } catch {
      return ''
    }
  }
  return ''
}

function imageFromListItem(html: string, href: string): string {
  const img = html.match(IMG_SRC_RE)
  if (img?.[1]) return normalizeImgSrc(img[1], href)
  return ''
}

/** Pull unique headline links from HTML blobs (HTML digest format). */
export function extractHtmlNewsLinks(...blobs: string[]): HtmlNewsLink[] {
  const seen = new Set<string>()
  const links: HtmlNewsLink[] = []
  for (const blob of blobs) {
    if (!blob?.trim()) continue

    let usedListItems = false
    LI_RE.lastIndex = 0
    let li: RegExpExecArray | null
    while ((li = LI_RE.exec(blob)) !== null) {
      const block = li[1]
      ANCHOR_RE.lastIndex = 0
      const m = ANCHOR_RE.exec(block)
      if (!m) continue
      const href = m[1].trim()
      const text = decodeHtmlEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim()
      if (!href || !text || seen.has(href)) continue
      seen.add(href)
      const image = imageFromListItem(block, href)
      links.push({ href, text, ...(image ? { image } : {}) })
      usedListItems = true
    }

    if (usedListItems) continue

    ANCHOR_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ANCHOR_RE.exec(blob)) !== null) {
      const href = m[1].trim()
      const text = decodeHtmlEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim()
      if (!href || !text || seen.has(href)) continue
      seen.add(href)
      links.push({ href, text })
    }
  }
  return links
}

export function extractFirstImageFromHtml(...blobs: string[]): string {
  for (const blob of blobs) {
    if (!blob?.trim()) continue
    const m = blob.match(IMG_SRC_RE)
    if (m?.[1]) {
      const url = normalizeImgSrc(m[1])
      if (url) return url
    }
  }
  return ''
}

export type NewsTextKind = 'headline' | 'summary' | 'body'

/**
 * Some feeds sometimes return HTML lists of links instead of plain text.
 * Extract readable copy for display.
 */
export function plainNewsText(raw: string, kind: NewsTextKind = 'body'): string {
  const input = raw.trim()
  if (!input) return ''
  if (!/<[a-z][\s\S]*>/i.test(input)) {
    return decodeHtmlEntities(input).replace(/\s+/g, ' ').trim()
  }

  const linkTexts = extractHtmlNewsLinks(input).map((l) => l.text)
  if (linkTexts.length > 0) {
    if (kind === 'headline') return linkTexts[0]!
    return linkTexts.join(' · ')
  }

  return decodeHtmlEntities(stripTags(input)).replace(/\s+/g, ' ').trim()
}
