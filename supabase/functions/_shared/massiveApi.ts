/**
 * Massive.com REST client (Polygon-compatible API).
 * Docs: https://massive.com/docs/rest/quickstart
 */

export class MassiveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = "MassiveApiError"
  }
}

export interface MassiveBar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v?: number
}

export interface MassiveQuote {
  participant_timestamp: number
  bid_price: number
  ask_price: number
}

export type MassiveAssetClass = "forex" | "crypto" | "indices"

export interface MassiveClientOptions {
  apiKey: string
  baseUrl?: string
  /** Free/starter tiers are often 5 calls/min — space requests accordingly. */
  callsPerMinute?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Serialize Massive HTTP calls to respect per-minute quotas. */
class MassiveRateLimiter {
  private chain: Promise<void> = Promise.resolve()
  private lastAt = 0
  private readonly minGapMs: number

  constructor(callsPerMinute: number) {
    const n = Math.max(1, callsPerMinute)
    this.minGapMs = Math.ceil(60_000 / n) + 200
  }

  acquire(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const wait = this.lastAt + this.minGapMs - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastAt = Date.now()
    })
    return this.chain
  }
}

function parseErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>
    if (typeof o.error === "string" && o.error) return o.error
    if (typeof o.message === "string" && o.message) return o.message
    if (typeof o.status === "string" && o.status !== "OK") return o.status
  }
  if (typeof body === "string" && body) return body.slice(0, 240)
  return fallback
}

export function massiveCallsPerMinuteFromEnv(env: { get(name: string): string | undefined }): number {
  const n = Number(env.get("MASSIVE_CALLS_PER_MINUTE") ?? "5")
  return Number.isFinite(n) && n > 0 ? n : 5
}

export class MassiveClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly limiter: MassiveRateLimiter
  readonly callsPerMinute: number

  constructor(opts: MassiveClientOptions) {
    this.apiKey = opts.apiKey.trim()
    this.baseUrl = (opts.baseUrl ?? "https://api.massive.com").replace(/\/$/, "")
    this.callsPerMinute = opts.callsPerMinute ?? 5
    this.limiter = new MassiveRateLimiter(this.callsPerMinute)
    if (!this.apiKey) throw new MassiveApiError("MASSIVE_API_KEY is not configured", 503)
  }

  static fromEnv(env: { get(name: string): string | undefined }): MassiveClient {
    const apiKey = env.get("MASSIVE_API_KEY") ?? env.get("POLYGON_API_KEY") ?? ""
    const baseUrl = env.get("MASSIVE_API_BASE_URL") ?? env.get("POLYGON_API_BASE_URL")
    return new MassiveClient({
      apiKey,
      baseUrl,
      callsPerMinute: massiveCallsPerMinuteFromEnv(env),
    })
  }

  /** One lightweight connectivity check (single HTTP call, no pagination). */
  async probeConnectivity(): Promise<{ ok: boolean; bars: number; error?: string }> {
    try {
      const to = new Date()
      const from = new Date(to)
      from.setDate(from.getDate() - 3)
      const fromStr = from.toISOString().slice(0, 10)
      const toStr = to.toISOString().slice(0, 10)
      const raw = await this.fetchJson<{
        results?: MassiveBar[]
        status?: string
      }>(
        `/v2/aggs/ticker/C:XAUUSD/range/1/day/${fromStr}/${toStr}`,
        { limit: "3", sort: "desc" },
      )
      const bars = raw.results ?? []
      if (bars.length === 0) {
        return { ok: false, bars: 0, error: "API responded but returned no bars (check plan/symbol)" }
      }
      return { ok: true, bars: bars.length }
    } catch (e) {
      return {
        ok: false,
        bars: 0,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  private async fetchJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    url.searchParams.set("apiKey", this.apiKey)
    for (const [k, v] of Object.entries(params)) {
      if (v !== "") url.searchParams.set(k, v)
    }

    let lastErr: unknown
    let lastStatus = 0

    for (let attempt = 0; attempt < 4; attempt++) {
      await this.limiter.acquire()
      try {
        const res = await fetch(url.toString())
        const text = await res.text()
        let body: unknown = null
        if (text) {
          try { body = JSON.parse(text) } catch { body = text }
        }

        if (res.status === 429) {
          const retrySec = Number(res.headers.get("Retry-After") ?? "0") || 60
          lastStatus = 429
          lastErr = new MassiveApiError(
            `Rate limited (max ~${this.callsPerMinute} calls/min). Retry after ${retrySec}s.`,
            429,
          )
          await sleep(Math.min(90_000, retrySec * 1000))
          continue
        }

        if (!res.ok) {
          const msg = parseErrorMessage(body, text || `HTTP ${res.status}`)
          throw new MassiveApiError(msg, res.status)
        }

        return body as T
      } catch (e) {
        lastErr = e
        if (e instanceof MassiveApiError) {
          lastStatus = e.status
          if (e.status >= 400 && e.status < 500 && e.status !== 429) throw e
        }
        await sleep(500 * (attempt + 1))
      }
    }

    if (lastErr instanceof MassiveApiError) throw lastErr
    throw new MassiveApiError(
      lastStatus === 429
        ? `Massive rate limit exceeded (~${this.callsPerMinute} calls/min on your plan)`
        : "Massive API request failed after retries",
      lastStatus || 502,
    )
  }

  private async fetchUrlJson<T>(url: string): Promise<T> {
    await this.limiter.acquire()
    const full = url.includes("apiKey=") ? url : `${url}${url.includes("?") ? "&" : "?"}apiKey=${this.apiKey}`
    const res = await fetch(full)
    const text = await res.text()
    let body: unknown = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    if (res.status === 429) {
      throw new MassiveApiError(
        `Rate limited (~${this.callsPerMinute} calls/min)`,
        429,
      )
    }
    if (!res.ok) {
      throw new MassiveApiError(parseErrorMessage(body, text || `HTTP ${res.status}`), res.status)
    }
    return body as T
  }

  /** GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to} */
  async getAggregates(
    ticker: string,
    multiplier: number,
    timespan: "minute" | "hour" | "day",
    fromMs: number,
    toMs: number,
    opts?: { limit?: number; sort?: "asc" | "desc"; maxPages?: number },
  ): Promise<MassiveBar[]> {
    const all: MassiveBar[] = []
    let cursorFrom = fromMs
    const limit = opts?.limit ?? 50_000
    const sort = opts?.sort ?? "asc"
    const maxPages = opts?.maxPages ?? 20

    for (let page = 0; page < maxPages && cursorFrom <= toMs; page++) {
      const path =
        `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/${timespan}/${cursorFrom}/${toMs}`
      const raw = await this.fetchJson<{
        results?: MassiveBar[]
        status?: string
      }>(path, { limit: String(limit), sort })

      const batch = raw.results ?? []
      if (batch.length === 0) break
      all.push(...batch)
      const lastT = batch[batch.length - 1]?.t
      if (!lastT || batch.length < limit) break
      cursorFrom = lastT + 1
      if (all.length >= 500_000) break
    }
    return all
  }

  /** GET /v3/quotes/{fxTicker} — tick-level BBO for forex (many pages; avoid on 5/min plans). */
  async getForexQuotes(
    fxTicker: string,
    fromNs: number,
    toNs: number,
    opts?: { limit?: number; maxPages?: number },
  ): Promise<MassiveQuote[]> {
    const all: MassiveQuote[] = []
    let nextUrl: string | null = null
    const limit = opts?.limit ?? 50_000
    const maxPages = opts?.maxPages ?? 3

    for (let page = 0; page < maxPages; page++) {
      const raw = nextUrl
        ? await this.fetchUrlJson<{ results?: MassiveQuote[]; next_url?: string }>(nextUrl)
        : await this.fetchJson<{ results?: MassiveQuote[]; next_url?: string }>(
          `/v3/quotes/${encodeURIComponent(fxTicker)}`,
          {
            "timestamp.gte": String(fromNs),
            "timestamp.lte": String(toNs),
            limit: String(limit),
            sort: "participant_timestamp",
            order: "asc",
          },
        )

      const batch = raw.results ?? []
      all.push(...batch)
      nextUrl = raw.next_url ?? null
      if (!nextUrl || batch.length === 0) break
    }
    return all
  }
}
