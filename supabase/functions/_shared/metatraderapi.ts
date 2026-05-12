/**
 * Minimal MetatraderAPI (metatraderapi.dev) client for the Deno edge runtime.
 * All endpoints are GET with query parameters per
 * https://docs.metatraderapi.dev/docs/metatrader-5-api.
 */

const DEFAULT_BASE_URL = "https://api.metatraderapi.dev"

export type MtPlatform = "MT4" | "MT5"

export interface AccountSummary {
  balance?: number
  credit?: number
  profit?: number
  equity?: number
  margin?: number
  freeMargin?: number
  marginLevel?: number
  leverage?: number
  currency?: string
  type?: string
  isInvestor?: boolean
}

export interface RegisterAccountResult {
  id: string
  message?: string
}

export class MetatraderApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "MetatraderApiError"
    this.status = status
    this.code = code
  }
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    out.set(k, String(v))
  }
  return out.toString()
}

export class MetatraderApiClient {
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL) {
    if (!apiKey) throw new Error("MetatraderApiClient: apiKey is required")
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/+$/, "")
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined | null>): Promise<T> {
    const qs = buildQuery(params)
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": this.apiKey, accept: "application/json" },
    })
    const text = await res.text()
    let body: unknown = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    if (!res.ok) {
      const msg = (body && typeof body === "object" && "message" in (body as Record<string, unknown>))
        ? String((body as Record<string, unknown>).message)
        : (body && typeof body === "object" && "error" in (body as Record<string, unknown>))
          ? String((body as Record<string, unknown>).error)
          : text || `HTTP ${res.status}`
      const code = (body && typeof body === "object" && "code" in (body as Record<string, unknown>))
        ? String((body as Record<string, unknown>).code)
        : undefined
      throw new MetatraderApiError(msg, res.status, code)
    }
    return body as T
  }

  registerAccount(args: {
    platform: MtPlatform
    server: string
    login: string
    password: string
    name?: string
  }): Promise<RegisterAccountResult> {
    return this.get<RegisterAccountResult>("/RegisterAccount", {
      type: args.platform === "MT5" ? "Metatrader 5" : "Metatrader 4",
      server: args.server,
      user: args.login,
      password: args.password,
      name: args.name,
    })
  }

  deleteAccount(id: string): Promise<{ message?: string }> {
    return this.get<{ message?: string }>("/DeleteAccount", { id })
  }

  checkConnect(id: string): Promise<string> {
    return this.get<string>("/CheckConnect", { id })
  }

  accountSummary(id: string): Promise<AccountSummary> {
    return this.get<AccountSummary>("/AccountSummary", { id })
  }

  /** Market + pending orders currently open on the account (see docs: GET /OpenedOrders). */
  openedOrders(id: string): Promise<unknown[]> {
    return this.get<unknown[]>("/OpenedOrders", { id })
  }

  /** Last 100 closed orders from the current MT session (see docs: GET /ClosedOrders). */
  closedOrders(id: string): Promise<unknown[]> {
    return this.get<unknown[]>("/ClosedOrders", { id })
  }

  /** Live bid/ask for one symbol. Used by the virtual-pending sweep to decide whether
   *  a row's trigger has been crossed. */
  async quote(id: string, symbol: string): Promise<{ bid: number; ask: number }> {
    // Upstream endpoint is `/GetQuote` — `/Quote` returns 404.
    const raw = await this.get<unknown>("/GetQuote", { id, symbol })
    const root = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
    const r = (root.result && typeof root.result === "object") ? root.result as Record<string, unknown> : root
    const num = (v: unknown): number => {
      if (typeof v === "number" && Number.isFinite(v)) return v
      if (typeof v === "string" && v.trim()) { const n = Number(v); return Number.isFinite(n) ? n : 0 }
      return 0
    }
    const bid = num(r.bid ?? r.Bid)
    const ask = num(r.ask ?? r.Ask)
    if (bid <= 0 || ask <= 0) {
      throw new MetatraderApiError(`Quote: invalid bid/ask for ${symbol} (bid=${bid} ask=${ask})`, 200)
    }
    return { bid, ask }
  }

  /** Send a market or pending order. The sweep only ever sends market Buy/Sell. */
  async orderSend(id: string, args: {
    symbol: string
    operation: string
    volume: number
    price?: number
    slippage?: number
    stoploss?: number
    takeprofit?: number
    comment?: string
    expertID?: number
  }): Promise<{ ticket?: number; openPrice?: number; lots?: number; stopLoss?: number; takeProfit?: number }> {
    const raw = await this.get<unknown>("/OrderSend", {
      id,
      symbol: args.symbol,
      operation: args.operation,
      volume: args.volume,
      price: args.price ?? 0,
      slippage: args.slippage ?? 20,
      stoploss: args.stoploss ?? 0,
      takeprofit: args.takeprofit ?? 0,
      comment: args.comment,
      expertID: args.expertID ?? 0,
    })
    const root = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
    const r = (root.result && typeof root.result === "object") ? root.result as Record<string, unknown> : root
    const num = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v)) return v
      if (typeof v === "string" && v.trim()) { const n = Number(v); return Number.isFinite(n) ? n : undefined }
      return undefined
    }
    const ticket = num(r.ticket ?? r.Ticket ?? r.orderId ?? r.OrderID)
    if (!ticket || ticket <= 0) {
      const preview = JSON.stringify(raw).slice(0, 500)
      throw new MetatraderApiError(`OrderSend returned no ticket (response: ${preview})`, 200)
    }
    return {
      ticket,
      openPrice: num(r.openPrice ?? r.OpenPrice ?? r.price ?? r.Price),
      lots: num(r.lots ?? r.Lots ?? r.volume ?? r.Volume),
      stopLoss: num(r.stoploss ?? r.StopLoss ?? r.sl ?? r.SL),
      takeProfit: num(r.takeprofit ?? r.TakeProfit ?? r.tp ?? r.TP),
    }
  }

  /** Pull broker-side digits/point/stops_level/freeze_level for one symbol. */
  async symbolParams(id: string, symbol: string): Promise<{
    digits: number
    point: number
    stopsLevel: number
    freezeLevel: number
  }> {
    const raw = await this.get<unknown>("/SymbolParams", { id, symbol })
    const root = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
    const sym = (root.symbol ?? root.Symbol ?? root) as Record<string, unknown>
    const readNum = (...keys: string[]): number | undefined => {
      for (const k of keys) {
        const v = sym[k]
        if (v == null) continue
        const n = typeof v === "number" ? v : Number(v)
        if (Number.isFinite(n)) return n
      }
      return undefined
    }
    return {
      digits: readNum("digits", "Digits", "DIGITS") ?? 5,
      point: readNum("point", "Point", "POINT") ?? 0.00001,
      stopsLevel: Math.max(0, readNum("stopsLevel", "StopsLevel", "stops_level", "TradeStopsLevel", "trade_stops_level") ?? 0),
      freezeLevel: Math.max(0, readNum("freezeLevel", "FreezeLevel", "freeze_level", "TradeFreezeLevel", "trade_freeze_level") ?? 0),
    }
  }
}

export function makeClientFromEnv(env: { get(name: string): string | undefined }): MetatraderApiClient {
  const apiKey = env.get("METATRADERAPI_KEY") ?? ""
  const baseUrl = env.get("METATRADERAPI_BASE_URL") ?? DEFAULT_BASE_URL
  return new MetatraderApiClient(apiKey, baseUrl)
}
