import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { dedupeArticlesByUrl, expandMarketNewsRawItem, type MarketNewsArticle } from "../_shared/expandMarketNews.ts"
import { normalizeFmpNewsList } from "../_shared/normalizeFmpNews.ts"
import { enrichArticlesWithOgImages, isUsableImage } from "../_shared/ogImage.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { expires: number; body: string }>()

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

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
  return articles.map((a) => (shared.has(a.image.trim()) ? { ...a, image: "" } : a))
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405)

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? ""
    if (!token) return jsonResponse({ error: "Unauthorized" }, 401)
    const { data: authData, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !authData.user) return jsonResponse({ error: "Unauthorized" }, 401)

    const apiKey = (Deno.env.get("FMP_API_KEY") ?? "").trim()
    if (!apiKey) {
      return jsonResponse(
        { error: "FMP_API_KEY is not configured. Set it in Supabase Edge Function secrets." },
        503,
      )
    }

    const url = new URL(req.url)
    const page = Math.max(0, Math.floor(Number(url.searchParams.get("page") ?? "0") || 0))
    const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? "50") || 50)))
    const symbols = (url.searchParams.get("symbols") ?? "").trim()

    const cacheKey = symbols
      ? `fmp:forex:${symbols}:${page}:${limit}`
      : `fmp:forex:latest:${page}:${limit}`
    const cached = cache.get(cacheKey)
    if (cached && cached.expires > Date.now()) {
      return new Response(cached.body, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const fmpPath = symbols
      ? "https://financialmodelingprep.com/stable/news/forex"
      : "https://financialmodelingprep.com/stable/news/forex-latest"
    const fmpUrl = new URL(fmpPath)
    fmpUrl.searchParams.set("page", String(page))
    fmpUrl.searchParams.set("limit", String(limit))
    fmpUrl.searchParams.set("apikey", apiKey)
    if (symbols) fmpUrl.searchParams.set("symbols", symbols)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    let fmpRes: Response
    try {
      fmpRes = await fetch(fmpUrl.toString(), { signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }

    const text = await fmpRes.text()
    if (!fmpRes.ok) {
      return jsonResponse(
        { error: text || `FMP request failed (${fmpRes.status})` },
        fmpRes.status === 429 ? 429 : 502,
      )
    }

    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      return jsonResponse({ error: "Unexpected FMP response" }, 502)
    }

    if (parsed && typeof parsed === "object" && "Error Message" in (parsed as Record<string, unknown>)) {
      return jsonResponse({ error: String((parsed as Record<string, unknown>)["Error Message"]) }, 502)
    }

    const normalized = normalizeFmpNewsList(parsed)
    let articles = dedupeArticlesByUrl(
      normalized.flatMap((article) =>
        expandMarketNewsRawItem({
          id: article.id,
          category: article.category,
          datetime: article.datetime,
          headline: article.headline,
          summary: article.summary,
          source: article.source,
          image: article.image,
          url: article.url,
          related: article.related,
        })
      ),
    ).sort((a, b) => b.datetime - a.datetime)
    articles = stripSharedDigestImages(articles)
    articles = await enrichArticlesWithOgImages(articles, 20, 6)

    const body = JSON.stringify({ articles, page, limit })
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, body })
    return new Response(body, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error"
    return jsonResponse({ error: msg }, 500)
  }
})
