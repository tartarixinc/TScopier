import { supabase } from './supabase'
import { expandMarketNewsArticles } from './expandMarketNews'
import { MARKET_NEWS_CACHE_TTL_MS, marketNewsCacheKey } from './marketNewsCache'
import type { ForexNewsResponse, MarketNewsArticle } from './marketNewsTypes'
import { isUsableImage } from './resolveNewsImage'
import { fetchWithSessionCache } from './sessionDataCache'

export { peekMarketNewsCache } from './marketNewsCache'

function stripSharedDigestImages(articles: MarketNewsArticle[]): MarketNewsArticle[] {
  const counts = new Map<string, number>()
  for (const a of articles) {
    const img = a.image.trim()
    if (!isUsableImage(img)) continue
    counts.set(img, (counts.get(img) ?? 0) + 1)
  }
  const shared = new Set(
    [...counts.entries()].filter(([, n]) => n >= 3).map(([url]) => url),
  )
  if (shared.size === 0) return articles
  return articles.map((a) => (shared.has(a.image.trim()) ? { ...a, image: '' } : a))
}

async function fetchForexNewsFromNetwork(options?: {
  page?: number
  limit?: number
  symbols?: string
}): Promise<ForexNewsResponse> {
  const session = (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) throw new Error('Not signed in')

  const params = new URLSearchParams()
  params.set('page', String(options?.page ?? 0))
  params.set('limit', String(options?.limit ?? 50))
  if (options?.symbols?.trim()) params.set('symbols', options.symbols.trim())

  const base = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/market-news`
  const url = `${base}?${params.toString()}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      },
    })
  } catch {
    throw new Error(
      'Could not reach market-news. Deploy the edge function and set FMP_API_KEY (see docs/market-news-setup.md).',
    )
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : text || `HTTP ${res.status}`
    throw new Error(msg)
  }
  const parsed = data as ForexNewsResponse
  const articles = stripSharedDigestImages(
    expandMarketNewsArticles(parsed.articles ?? []),
  )
  return { ...parsed, articles }
}

export async function fetchForexNews(options?: {
  page?: number
  limit?: number
  symbols?: string
  forceRefresh?: boolean
}): Promise<ForexNewsResponse> {
  const key = marketNewsCacheKey(options)
  const { data } = await fetchWithSessionCache(
    key,
    MARKET_NEWS_CACHE_TTL_MS,
    () => fetchForexNewsFromNetwork(options),
    { forceRefresh: options?.forceRefresh },
  )
  return data
}
