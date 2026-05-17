import type { MarketNewsArticle } from "./expandMarketNews.ts"

function stableId(parts: string[]): number {
  let h = 0
  const s = parts.join("|")
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h) || 1
}

function parsePublishedToUnix(raw: unknown): number {
  const s = String(raw ?? "").trim()
  if (!s) return Math.floor(Date.now() / 1000)
  const ms = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z")
  if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  return Math.floor(Date.now() / 1000)
}

export function normalizeFmpNewsRow(raw: Record<string, unknown>): MarketNewsArticle | null {
  const headline = String(raw.title ?? raw.headline ?? "").trim()
  if (!headline) return null

  const url = String(raw.url ?? "").trim()
  const summary = String(raw.text ?? raw.summary ?? raw.snippet ?? "").trim()
  const published = raw.publishedDate ?? raw.date ?? raw.datetime
  const datetime = typeof raw.datetime === "number" && Number.isFinite(raw.datetime)
    ? Math.floor(raw.datetime)
    : parsePublishedToUnix(published)

  return {
    id: stableId([url, headline, String(datetime)]),
    category: "forex",
    datetime,
    headline,
    summary: summary || headline,
    source: String(raw.site ?? raw.source ?? "").trim(),
    image: String(raw.image ?? "").trim(),
    url,
    related: String(raw.symbol ?? raw.tickers ?? "").trim(),
  }
}

export function normalizeFmpNewsList(raw: unknown): MarketNewsArticle[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) => (row && typeof row === "object" ? normalizeFmpNewsRow(row as Record<string, unknown>) : null))
    .filter((a): a is MarketNewsArticle => a != null)
}
