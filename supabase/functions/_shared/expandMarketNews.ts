import { isUsableImage } from "./ogImage.ts"
import { extractFirstImageFromHtml, extractHtmlNewsLinks, plainNewsText } from "./stripHtml.ts"

export interface MarketNewsArticle {
  id: number
  category: string
  datetime: number
  headline: string
  summary: string
  source: string
  image: string
  url: string
  related: string
}

function articleIdFromLink(parentId: number, href: string, index: number): number {
  let h = parentId
  for (let i = 0; i < href.length; i++) h = ((h << 5) - h + href.charCodeAt(i)) | 0
  const id = Math.abs(h)
  return id > 0 ? id : parentId * 10_000 + index
}

/** One feed row may embed many stories as an HTML list — expand to one article per link. */
export function expandMarketNewsRawItem(raw: Record<string, unknown>): MarketNewsArticle[] {
  const id = Number(raw.id)
  const datetime = Number(raw.datetime)
  if (!Number.isFinite(id) || !Number.isFinite(datetime)) return []

  const category = String(raw.category ?? "").trim()
  const source = String(raw.source ?? "").trim()
  const headlineRaw = String(raw.headline ?? "")
  const summaryRaw = String(raw.summary ?? "")
  const topUrl = String(raw.url ?? "").trim()
  const rowImage = String(raw.image ?? "").trim()
  const htmlImage = extractFirstImageFromHtml(headlineRaw, summaryRaw)
  const parentImage = isUsableImage(rowImage) ? rowImage : htmlImage
  const related = String(raw.related ?? "").trim()

  const links = extractHtmlNewsLinks(headlineRaw, summaryRaw)

  if (links.length > 1) {
    // Do not copy digest thumbnail — every story gets its own cover via OG fetch.
    return links.map((link, index) => ({
      id: articleIdFromLink(id, link.href, index),
      category,
      datetime,
      source,
      related,
      headline: link.text,
      summary: link.text,
      url: link.href,
      image: link.image ?? "",
    }))
  }

  if (links.length === 1) {
    return [{
      id,
      category,
      datetime,
      source,
      related,
      headline: links[0].text,
      summary: plainNewsText(summaryRaw, "summary") || links[0].text,
      url: links[0].href || topUrl,
      image: links[0].image || parentImage,
    }]
  }

  const headline = plainNewsText(headlineRaw, "headline")
  if (!headline) return []

  return [{
    id,
    category,
    datetime,
    source,
    related,
    headline,
    summary: plainNewsText(summaryRaw, "summary"),
    url: topUrl,
    image: parentImage,
  }]
}

export function dedupeArticlesByUrl(articles: MarketNewsArticle[]): MarketNewsArticle[] {
  const seen = new Set<string>()
  const out: MarketNewsArticle[] = []
  for (const a of articles) {
    const key = a.url || `id:${a.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

export function expandMarketNewsRawList(raw: unknown[]): MarketNewsArticle[] {
  const expanded = raw.flatMap((item) =>
    item && typeof item === "object"
      ? expandMarketNewsRawItem(item as Record<string, unknown>)
      : []
  )
  return dedupeArticlesByUrl(expanded).sort((a, b) => b.datetime - a.datetime)
}
