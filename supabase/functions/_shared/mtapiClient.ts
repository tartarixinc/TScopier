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
    const raw = await this.request(
      "OrderHistory",
      { from, to },
      sessionId,
      platform,
      90_000,
    )
    return list(raw, ["orders", "Orders"], "OrderHistory")
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
