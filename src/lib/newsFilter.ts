import type { EconomicCalendarEvent, EconomicImpact } from './economicCalendarTypes'
import type { MarketNewsArticle } from './marketNewsTypes'

const CURRENCY_KEYWORDS: Record<string, RegExp> = {
  USD: /\b(USD|US\$|U\.S\.|United States|Fed|FOMC|NFP|non.?farm)\b/i,
  EUR: /\b(EUR|€|Eurozone|Euro area|ECB|Germany|France)\b/i,
  GBP: /\b(GBP|£|UK|Britain|BoE|Bank of England)\b/i,
  JPY: /\b(JPY|¥|Japan|BoJ)\b/i,
  AUD: /\b(AUD|Australia|RBA)\b/i,
  CAD: /\b(CAD|Canada|BoC)\b/i,
  CHF: /\b(CHF|Switzerland|SNB)\b/i,
  NZD: /\b(NZD|New Zealand|RBNZ)\b/i,
}

const HIGH_IMPACT_KEYWORDS =
  /\b(NFP|non.?farm|CPI|inflation|GDP|interest rate|rate decision|FOMC|ECB|BoE|BoJ|employment|PMI|retail sales)\b/i

/** Match forex news to calendar rows by currency keywords and optional time window (±hours). */
export function newsMatchesEvent(
  article: MarketNewsArticle,
  event: EconomicCalendarEvent,
  windowHours = 2,
): boolean {
  const text = `${article.headline} ${article.summary}`.toLowerCase()
  const currency = event.currency || event.country
  const re = CURRENCY_KEYWORDS[currency]
  if (re && !re.test(text)) {
    if (!text.includes(currency.toLowerCase()) && !text.includes(event.country.toLowerCase())) {
      return false
    }
  }

  const eventMs = Date.parse(event.datetime)
  const articleMs = article.datetime * 1000
  if (Number.isFinite(eventMs) && Number.isFinite(articleMs)) {
    const windowMs = windowHours * 60 * 60 * 1000
    if (Math.abs(articleMs - eventMs) > windowMs * 12) {
      // Allow same-day loose match for digest news without exact timestamps
      const eventDay = new Date(eventMs).toDateString()
      const articleDay = new Date(articleMs).toDateString()
      if (eventDay !== articleDay) return false
    }
  }

  if (event.impact === 'high' && !HIGH_IMPACT_KEYWORDS.test(text)) {
    const eventWords = event.event.split(/\s+/).filter((w) => w.length > 3)
    if (!eventWords.some((w) => text.includes(w.toLowerCase()))) return false
  }

  return true
}

export function filterNewsByCalendar(
  articles: MarketNewsArticle[],
  events: EconomicCalendarEvent[],
  opts: { impact?: EconomicImpact | 'all'; currency?: string },
): MarketNewsArticle[] {
  const impact = opts.impact ?? 'all'
  const currency = (opts.currency ?? 'ALL').toUpperCase()

  const relevantEvents = events.filter((e) => {
    if (impact !== 'all' && e.impact !== impact) return false
    if (currency !== 'ALL' && e.currency !== currency && e.country !== currency) return false
    return true
  })

  if (relevantEvents.length === 0) return []

  return articles.filter((article) =>
    relevantEvents.some((event) => newsMatchesEvent(article, event)),
  )
}

export function groupEventsByDay(events: EconomicCalendarEvent[]): Map<string, EconomicCalendarEvent[]> {
  const map = new Map<string, EconomicCalendarEvent[]>()
  for (const e of events) {
    const day = e.datetime.slice(0, 10)
    const list = map.get(day) ?? []
    list.push(e)
    map.set(day, list)
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}
