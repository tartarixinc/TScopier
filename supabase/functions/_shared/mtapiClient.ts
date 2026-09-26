/**
 * Minimal MTAPI HTTP client for Deno edge functions.
 *
 * Read-only endpoints mirror worker MtapiProvider shapes:
 *   GET /OpenedOrders, /OrderHistory, /HistoryPositions, /ClosedOrders, /AccountSummary
 * Session id is passed as `?id=` (same protocol as the worker bridge).
 */

export class MtapiApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = "MtapiApiError"
  }
}

function envString(env: Deno.Env, name: string): string {
  return String(env.get(name) ?? "").trim()
}

export function isMtapiConfigured(env: Deno.Env): boolean {
  return envString(env, "MTAPI_BASE_URL").length > 0
}

function baseUrl(env: Deno.Env, platform?: string | null): string {
  const platformUpper = String(platform ?? "MT5").toUpperCase()
  const specific = envString(env, platformUpper === "MT4" ? "MTAPI_MT4_BASE_URL" : "MTAPI_MT5_BASE_URL")
  const base = (specific || envString(env, "MTAPI_BASE_URL")).replace(/\/+$/, "")
  if (!base) {
    throw new MtapiApiError(
      "MTAPI is not configured. Set MTAPI_BASE_URL in Supabase Edge secrets.",
      503,
      "NOT_CONFIGURED",
    )
  }
  return base
}

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function errorDetails(value: unknown): { code?: string; message?: string } {
  const row = object(value)
  const rawError = row.error ?? row.Error
  const nested = object(rawError)
  const code = row.code ?? row.Code ?? nested.code ?? nested.Code
    ?? (typeof rawError === "string" ? rawError : undefined)
  const message = row.message ?? row.Message ?? row.errorMessage ?? nested.message ?? nested.Message
  return {
    code: code == null ? undefined : String(code),
    message: message == null ? undefined : String(message),
  }
}

function list(value: unknown, keys: string[], endpoint: string): unknown[] {
  if (Array.isArray(value)) return value
  const row = object(value)
  for (const key of keys) if (Array.isArray(row[key])) return row[key] as unknown[]
  const result = row.result ?? row.Result
  if (Array.isArray(result)) return result
  const nested = object(result)
  for (const key of keys) if (Array.isArray(nested[key])) return nested[key] as unknown[]
  throw new MtapiApiError(endpoint + " returned an invalid list response", 502, "INVALID_RESPONSE")
}

export interface MtapiClientOptions {
  env: Deno.Env
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Read methods share the FxSocket client signatures used by fxsocketTrades
 * (session id + optional platform), so one trades pipeline serves both providers.
 */
export class MtapiClient {
  /**
   * Closed trade rows are served from OrderHistory: bridge sessions are
   * connected without `downloadOrderHistory`, so HistoryPositions fails with
   * ORDER_HISTORY_NOT_READY. See MtHistorySource.closedHistorySource.
   */
  readonly closedHistorySource = "order_history" as const

  private readonly env: Deno.Env
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: MtapiClientOptions) {
    this.env = options.env
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  private async request(
    endpoint: string,
    params: Record<string, string | number | boolean | null | undefined>,
    sessionId: string,
    platform?: string | null,
    timeoutMs?: number,
  ): Promise<unknown> {
    const url = new URL(baseUrl(this.env, platform) + "/" + endpoint)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value))
      }
    }
    if (sessionId) url.searchParams.set("id", sessionId)

    const headers: Record<string, string> = { accept: "application/json, text/plain" }
    const proxyKey = envString(this.env, "MTAPI_PROXY_KEY") || envString(this.env, "MTAPI_API_KEY")
    if (proxyKey) headers["Authorization"] = "Bearer " + proxyKey
    const internalToken = envString(this.env, "MTAPI_INTERNAL_TOKEN")
    if (internalToken) headers["X-Internal-Token"] = internalToken

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      })
      const text = await response.text()
      let body: unknown = text
      if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
        try {
          body = JSON.parse(text)
        } catch {
          /* caller validates shape */
        }
      }
      const details = errorDetails(body)
      if (!response.ok || details.code) {
        throw new MtapiApiError(
          details.message || details.code || ("MTAPI " + endpoint + " failed"),
          response.status,
          details.code,
        )
      }
      return body
    } catch (error) {
      if (error instanceof MtapiApiError) throw error
      const message = error instanceof Error && error.name === "AbortError"
        ? "MTAPI " + endpoint + " timed out"
        : "MTAPI " + endpoint + " request failed"
      throw new MtapiApiError(message, 503, "TRANSPORT_ERROR")
    } finally {
      clearTimeout(timer)
    }
  }

  async openedOrders(sessionId: string, platform?: string | null): Promise<unknown[]> {
    const raw = await this.request("OpenedOrders", {}, sessionId, platform)
    return list(raw, ["orders", "Orders"], "OpenedOrders")
  }

  async closedOrders(sessionId: string, platform?: string | null): Promise<unknown[]> {
    const raw = await this.request("ClosedOrders", {}, sessionId, platform)
    return list(raw, ["orders", "Orders"], "ClosedOrders")
  }

  async orderHistory(
    sessionId: string,
    from: string,
    to: string,
    platform?: string | null,
  ): Promise<unknown[]> {
    const startedAt = Date.now()
    const raw = await this.request(
      "OrderHistory",
      { from, to },
      sessionId,
      platform,
      90_000,
    )
    const rows = list(raw, ["orders", "Orders"], "OrderHistory")
    if (object(raw).partialResponse !== true) return rows

    // The bridge truncated the response — re-read through the paginated
    // endpoint so large histories stay complete (mirrors the worker's
    // orderHistoryPage flow). Safety cap: 40 pages × 500 rows = 20k rows,
    // windowed to the newest pages (start = pagesCount - maxPages) like the
    // worker. Pages are fetched NEWEST-FIRST so a budget cut or a mid-loop
    // failure keeps the most recent rows (consumers dedupe by ticket and
    // re-sort by time, so row order does not matter), and page 0's probe
    // rows are reused when page 0 is inside the window. Budget: 30s from
    // now but never past 115s from method entry, so the 120s client-side
    // edge-call timeout still wins over this whole read; on expiry return
    // what we have (never throw) — this runs every 15s poll. If the
    // paginated endpoint is unavailable, keep the truncated rows rather
    // than failing the whole read. `ascending: true` is pinned so the
    // newest-window selection never depends on the bridge default.
    const all: unknown[] = []
    try {
      const ordersPerPage = 500
      const maxPages = 40
      const deadline = Math.min(startedAt + 115_000, Date.now() + 30_000)
      const pageTimeoutMs = () => Math.max(1_000, Math.min(90_000, deadline - Date.now()))
      const page0 = object(await this.request(
        "OrderHistoryPagination",
        { from, to, pageNumber: 0, ordersPerPage, ascending: true },
        sessionId,
        platform,
        pageTimeoutMs(),
      ))
      const rawPages = Number(page0.pagesCount ?? page0.PagesCount ?? page0.totalPages)
      const pagesCount = Number.isFinite(rawPages) ? Math.max(1, Math.floor(rawPages)) : 1
      const start = Math.max(0, pagesCount - maxPages)
      if (start > 0) {
        console.warn(
          `[mtapiClient] OrderHistory pagination capped at ${maxPages}/${pagesCount} pages — reading the newest window (pages ${start}..${pagesCount - 1})`,
        )
      }
      // Page 0 doubles as the pagesCount probe; reuse its rows when it is
      // inside the window (oldest page, already paid for) instead of
      // refetching it at the end of the loop.
      const reuseProbe = start === 0
      if (reuseProbe) {
        all.push(...list(page0, ["orders", "Orders"], "OrderHistoryPagination"))
      }
      const loopFloor = reuseProbe ? 1 : start
      for (let pageNumber = pagesCount - 1; pageNumber >= loopFloor; pageNumber -= 1) {
        // Always attempt the newest page (first iteration) even if the
        // probe already burned the budget; check the deadline after that.
        if (pageNumber !== pagesCount - 1 && Date.now() >= deadline) {
          console.warn(
            `[mtapiClient] OrderHistory pagination stopped after ${all.length} rows (${rows.length} truncated) — pagination budget exhausted`,
          )
          break
        }
        const next = await this.request(
          "OrderHistoryPagination",
          { from, to, pageNumber, ordersPerPage, ascending: true },
          sessionId,
          platform,
          pageTimeoutMs(),
        )
        all.push(...list(next, ["orders", "Orders"], "OrderHistoryPagination"))
      }
      if (all.length === 0 && rows.length > 0) {
        console.warn(
          `[mtapiClient] OrderHistoryPagination returned no rows — keeping ${rows.length} truncated rows`,
        )
        return rows
      }
      console.warn(
        `[mtapiClient] OrderHistory partialResponse=true — read ${all.length} rows via OrderHistoryPagination`,
      )
      return all
    } catch (err) {
      console.warn(
        `[mtapiClient] OrderHistoryPagination failed (${err instanceof Error ? err.message : String(err)}) — returning ${all.length ? `${all.length} newest paginated rows` : `${rows.length} truncated rows`}`,
      )
      return all.length ? all : rows
    }
  }

  async positionHistory(
    sessionId: string,
    from: string,
    to: string,
    platform?: string | null,
  ): Promise<unknown[]> {
    const raw = await this.request(
      "HistoryPositions",
      { from, to },
      sessionId,
      platform,
      90_000,
    )
    return list(raw, ["positions", "Positions", "orders", "Orders"], "HistoryPositions")
  }

  async accountSummary(
    sessionId: string,
    platform?: string | null,
  ): Promise<Record<string, unknown>> {
    const row = object(await this.request("AccountSummary", {}, sessionId, platform))
    if (Object.keys(row).length === 0) {
      throw new MtapiApiError("AccountSummary returned an invalid response", 502, "INVALID_RESPONSE")
    }
    return row
  }

  /** Market bid/ask for one symbol (GET /GetQuote). Same shape as FxSocket getQuote. */
  async getQuote(
    sessionId: string,
    symbol: string,
    platform?: string | null,
  ): Promise<Record<string, unknown>> {
    const row = object(await this.request("GetQuote", { symbol }, sessionId, platform))
    const bid = Number(row.bid ?? row.Bid)
    const ask = Number(row.ask ?? row.Ask)
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
      throw new MtapiApiError("GetQuote returned invalid prices", 502, "INVALID_RESPONSE")
    }
    const time = row.time ?? row.Time
    return {
      symbol: String(row.symbol ?? row.Symbol ?? symbol),
      bid,
      ask,
      time: time == null ? undefined : String(time),
    }
  }
}

/** Map raw MTAPI AccountSummary into the FxSocket summary shape used by the UI. */
export function normalizeMtapiAccountSummary(row: Record<string, unknown>): {
  balance?: number
  credit?: number
  profit?: number
  equity?: number
  margin?: number
  freeMargin?: number
  marginLevel?: number
  leverage?: number
  currency?: string
} {
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const v = row[key]
      if (v === undefined || v === null || v === "") continue
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return undefined
  }
  const currency = row.currency ?? row.Currency
  return {
    balance: num("balance", "Balance"),
    credit: num("credit", "Credit"),
    profit: num("profit", "Profit"),
    equity: num("equity", "Equity"),
    margin: num("margin", "Margin"),
    freeMargin: num("freeMargin", "FreeMargin"),
    marginLevel: num("marginLevel", "MarginLevel"),
    leverage: num("leverage", "Leverage"),
    currency: currency == null ? undefined : String(currency),
  }
}
