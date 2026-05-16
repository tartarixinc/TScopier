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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class MassiveClient {
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(opts: MassiveClientOptions) {
    this.apiKey = opts.apiKey.trim()
    this.baseUrl = (opts.baseUrl ?? "https://api.massive.com").replace(/\/$/, "")
    if (!this.apiKey) throw new MassiveApiError("MASSIVE_API_KEY is not configured", 503)
  }

  static fromEnv(env: { get(name: string): string | undefined }): MassiveClient {
    const apiKey = env.get("MASSIVE_API_KEY") ?? env.get("POLYGON_API_KEY") ?? ""
    const baseUrl = env.get("MASSIVE_API_BASE_URL") ?? env.get("POLYGON_API_BASE_URL")
    return new MassiveClient({ apiKey, baseUrl })
  }

  private async fetchJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    url.searchParams.set("apiKey", this.apiKey)
    for (const [k, v] of Object.entries(params)) {
      if (v !== "") url.searchParams.set(k, v)
    }

    let lastErr: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(url.toString())
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After") ?? "2")
          await sleep(Math.min(30_000, (retryAfter || 2) * 1000 * (attempt + 1)))
          continue
        }
        const text = await res.text()
        let body: unknown = null
        if (text) {
          try { body = JSON.parse(text) } catch { body = text }
        }
        if (!res.ok) {
          const msg = body && typeof body === "object" && "error" in (body as Record<string, unknown>)
            ? String((body as Record<string, unknown>).error)
            : text || `HTTP ${res.status}`
          throw new MassiveApiError(msg, res.status)
        }
        return body as T
      } catch (e) {
        lastErr = e
        if (e instanceof MassiveApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
          throw e
        }
        await sleep(400 * (attempt + 1))
      }
    }
    throw lastErr instanceof Error ? lastErr : new MassiveApiError("Massive API request failed", 502)
  }

  /** GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to} */
  async getAggregates(
    ticker: string,
    multiplier: number,
    timespan: "minute" | "hour" | "day",
    fromMs: number,
    toMs: number,
    opts?: { limit?: number; sort?: "asc" | "desc" },
  ): Promise<MassiveBar[]> {
    const all: MassiveBar[] = []
    let cursorFrom = fromMs
    const limit = opts?.limit ?? 50_000
    const sort = opts?.sort ?? "asc"

    while (cursorFrom <= toMs) {
      const path =
        `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/${timespan}/${cursorFrom}/${toMs}`
      const raw = await this.fetchJson<{
        results?: MassiveBar[]
        next_url?: string
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

  /** GET /v3/quotes/{fxTicker} — tick-level BBO for forex */
  async getForexQuotes(
    fxTicker: string,
    fromNs: number,
    toNs: number,
    opts?: { limit?: number },
  ): Promise<MassiveQuote[]> {
    const all: MassiveQuote[] = []
    let nextUrl: string | null = null
    const limit = opts?.limit ?? 50_000

    for (let page = 0; page < 100; page++) {
      const raw = nextUrl
        ? await fetch(nextUrl.includes("apiKey=") ? nextUrl : `${nextUrl}&apiKey=${this.apiKey}`)
            .then((r) => r.json() as Promise<{ results?: MassiveQuote[]; next_url?: string }>)
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
