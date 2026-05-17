import type { MarketNewsArticle } from './marketNewsTypes'
import { extractHtmlNewsLinks, plainNewsText } from './stripHtml'

function articleIdFromLink(parentId: number, href: string, index: number): number {
  let h = parentId
  for (let i = 0; i < href.length; i++) h = ((h << 5) - h + href.charCodeAt(i)) | 0
  const id = Math.abs(h)
  return id > 0 ? id : parentId * 10_000 + index
}

function expandOne(article: MarketNewsArticle): MarketNewsArticle[] {
  const links = extractHtmlNewsLinks(article.headline, article.summary)
  const parentImage = article.image

  if (links.length > 1) {
    return links.map((link, index) => ({
      ...article,
      id: articleIdFromLink(article.id, link.href, index),
      headline: link.text,
      summary: link.text,
      url: link.href,
      image: link.image ?? '',
    }))
  }

  return [{
    ...article,
    headline: plainNewsText(article.headline, 'headline'),
    summary: plainNewsText(article.summary, 'summary'),
    url: links[0]?.href || article.url,
    image: links[0]?.image || parentImage,
  }]
}

function dedupeByUrl(articles: MarketNewsArticle[]): MarketNewsArticle[] {
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

/** Expand HTML digests and normalize text (client fallback if edge is not redeployed). */
export function expandMarketNewsArticles(articles: MarketNewsArticle[]): MarketNewsArticle[] {
  return dedupeByUrl(articles.flatMap(expandOne)).sort((a, b) => b.datetime - a.datetime)
}
