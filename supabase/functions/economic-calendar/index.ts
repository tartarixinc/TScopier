import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import {
  filterCalendarEvents,
  normalizeFmpCalendarList,
} from "../_shared/normalizeEconomicCalendar.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const CACHE_TTL_MS = 20 * 60 * 1000
const cache = new Map<string, { expires: number; body: string }>()

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function parseDateParam(value: string | null, fallback: Date): string {
  const v = (value ?? "").trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  return isoDate(fallback)
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
    const today = new Date()
    const weekAhead = new Date(today)
    weekAhead.setDate(weekAhead.getDate() + 7)
    const weekBack = new Date(today)
    weekBack.setDate(weekBack.getDate() - 1)

    const from = parseDateParam(url.searchParams.get("from"), weekBack)
    const to = parseDateParam(url.searchParams.get("to"), weekAhead)
    const country = (url.searchParams.get("country") ?? "ALL").trim()
    const impact = (url.searchParams.get("impact") ?? "all").trim().toLowerCase()

    const cacheKey = `cal:v1:${from}:${to}:${country}:${impact}`
    const cached = cache.get(cacheKey)
    if (cached && cached.expires > Date.now()) {
      return new Response(cached.body, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const fmpUrl = new URL("https://financialmodelingprep.com/stable/economic-calendar")
    fmpUrl.searchParams.set("from", from)
    fmpUrl.searchParams.set("to", to)
    fmpUrl.searchParams.set("apikey", apiKey)

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

    const events = filterCalendarEvents(normalizeFmpCalendarList(parsed), { country, impact })
    const body = JSON.stringify({ events, from, to })
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
