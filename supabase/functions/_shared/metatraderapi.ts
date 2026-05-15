/**
 * MT4/MT5 REST client (mt4api.dev) for Deno edge functions.
 * Basic Auth + platform-specific hosts. See docs/mt4api-endpoint-map.md.
 */

const DEFAULT_MT5_BASE = "https://mt5.mt4api.dev"
const DEFAULT_MT4_BASE = "https://mt4.mt4api.dev"

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

type EnvGetter = { get(name: string): string | undefined }

function trimEnv(v: string | undefined): string {
  return (v ?? "").trim()
}

/** RFC 7617: Authorization: Basic base64(username + ":" + password) */
function basicAuthHeaderFromUserPass(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return `Basic ${btoa(binary)}`
}

function normalizeAuthorizationHeader(value: string): string {
  const v = value.trim()
  if (!v) return ""
  return /^Basic\s+/i.test(v) ? v : `Basic ${v}`
}

/**
 * Resolve MT API Basic Auth from env. Prefer plain USER + PASSWORD (we base64-encode).
 * Optional: MT4API_BASIC_TOKEN = already-encoded base64(user:pass), or
 * MT4API_AUTHORIZATION = full header value ("Basic …").
 */
export function resolveBasicAuthHeader(env: EnvGetter): string {
  const authorization = trimEnv(env.get("MT4API_AUTHORIZATION"))
  if (authorization) return normalizeAuthorizationHeader(authorization)

  const token = trimEnv(env.get("MT4API_BASIC_TOKEN"))
  if (token) return normalizeAuthorizationHeader(token)

  const user = trimEnv(env.get("MT4API_BASIC_USER") ?? env.get("METATRADERAPI_BASIC_USER"))
  const password = trimEnv(env.get("MT4API_BASIC_PASSWORD") ?? env.get("METATRADERAPI_BASIC_PASSWORD"))
  if (!user || !password) {
    throw new Error("MT4API_BASIC_USER and MT4API_BASIC_PASSWORD are required (plain text, not base64)")
  }
  return basicAuthHeaderFromUserPass(user, password)
}

export function isMtApiAuthConfigured(env: EnvGetter): boolean {
  try {
    resolveBasicAuthHeader(env)
    return true
  } catch {
    return false
  }
}

function parseToken(body: unknown, fallbackId: string): string {
  if (typeof body === "string") {
    const t = body.trim().replace(/^"|"$/g, "")
    if (t) return t
  }
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>
    const id = o.id ?? o.Id ?? o.token ?? o.Token
    if (id != null && String(id).trim()) return String(id).trim()
  }
  return fallbackId
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function normalizeAccountSummary(body: unknown): AccountSummary {
  if (body == null || typeof body !== "object") return {}
  const root = body as Record<string, unknown>
  const o = (root.result && typeof root.result === "object")
    ? root.result as Record<string, unknown>
    : root
  return {
    balance: num(o.balance ?? o.Balance),
    credit: num(o.credit ?? o.Credit),
    profit: num(o.profit ?? o.Profit),
    equity: num(o.equity ?? o.Equity),
    margin: num(o.margin ?? o.Margin),
    freeMargin: num(o.freeMargin ?? o.FreeMargin ?? o.marginFree ?? o.MarginFree),
    marginLevel: num(o.marginLevel ?? o.MarginLevel),
    leverage: num(o.leverage ?? o.Leverage),
    currency: typeof o.currency === "string" ? o.currency : typeof o.Currency === "string" ? o.Currency : undefined,
    type: typeof o.type === "string" ? o.type : typeof o.Type === "string" ? String(o.Type) : undefined,
    isInvestor: Boolean(o.isInvestor ?? o.IsInvestor),
  }
}

function assertNoApiError(body: unknown): void {
  if (body == null || typeof body !== "object") return
  const root = body as Record<string, unknown>
  const err = root.error
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>
    const m = String(e.message ?? e.Message ?? "").trim()
    if (m && m !== "null") throw new MetatraderApiError(m, 200, e.code != null ? String(e.code) : undefined)
  }
  if (!("result" in root) && !("ticket" in root) && !("Ticket" in root)) {
    const m = root.message ?? root.Message
    const code = root.code ?? root.Code
    if (typeof m === "string" && m.trim()) {
      throw new MetatraderApiError(m.trim(), 200, code != null ? String(code) : undefined)
    }
  }
}

interface PlatformPaths {
  orderSend: string
  orderModify: string
  orderClose: string
  quote: string
}

function pathsFor(platform: MtPlatform): PlatformPaths {
  if (platform === "MT5") {
    return {
      orderSend: "/OrderSendSafe",
      orderModify: "/OrderModifySafe",
      orderClose: "/OrderCloseSafe",
      quote: "/GetQuote",
    }
  }
  return {
    orderSend: "/OrderSend",
    orderModify: "/OrderModify",
    orderClose: "/OrderClose",
    quote: "/Quote",
  }
}

export class MetatraderApiClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly paths: PlatformPaths
  readonly platform: MtPlatform

  constructor(platform: MtPlatform, authHeader: string, baseUrl?: string) {
    const header = authHeader.trim()
    if (!header) {
      throw new Error("MetatraderApiClient: Authorization header required")
    }
    this.platform = platform
    const defaultBase = platform === "MT5" ? DEFAULT_MT5_BASE : DEFAULT_MT4_BASE
    this.baseUrl = (baseUrl ?? defaultBase).replace(/\/+$/, "")
    this.authHeader = normalizeAuthorizationHeader(header)
    this.paths = pathsFor(platform)
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined | null>): Promise<T> {
    const qs = buildQuery(params)
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: this.authHeader, accept: "application/json, text/plain" },
    })
    const text = await res.text()
    let body: unknown = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    if (!res.ok) {
      const msg = (body && typeof body === "object" && "message" in (body as Record<string, unknown>))
        ? String((body as Record<string, unknown>).message)
        : text || `HTTP ${res.status}`
      throw new MetatraderApiError(msg, res.status)
    }
    return body as T
  }

  /** Connect with credentials; `id` must be client-generated UUID v4. */
  async connectEx(args: {
    id: string
    server: string
    login: string
    password: string
  }): Promise<string> {
    const userNum = Number(args.login)
    if (!Number.isFinite(userNum)) {
      throw new MetatraderApiError("Invalid MT login number", 400)
    }
    const raw = await this.get<unknown>("/ConnectEx", {
      id: args.id,
      user: userNum,
      password: args.password,
      server: args.server,
    })
    return parseToken(raw, args.id)
  }

  /** Reconnect using stored token (no password). */
  async connectByToken(id: string): Promise<void> {
    await this.get<unknown>("/ConnectByToken", { id })
  }

  async ensureConnected(id: string): Promise<void> {
    try {
      await this.checkConnect(id)
      return
    } catch {
      /* try reconnect */
    }
    await this.connectByToken(id)
  }

  /** @deprecated Use disconnect — kept as alias for rollback paths */
  async deleteAccount(id: string): Promise<{ message?: string }> {
    return this.disconnect(id)
  }

  async disconnect(id: string): Promise<{ message?: string }> {
    const raw = await this.get<unknown>("/Disconnect", { id })
    if (typeof raw === "string") return { message: raw }
    return { message: "OK" }
  }

  checkConnect(id: string): Promise<string> {
    return this.get<string>("/CheckConnect", { id })
  }

  async accountSummary(id: string): Promise<AccountSummary> {
    const raw = await this.get<unknown>("/AccountSummary", { id })
    assertNoApiError(raw)
    return normalizeAccountSummary(raw)
  }

  openedOrders(id: string): Promise<unknown[]> {
    return this.get<unknown[]>("/OpenedOrders", { id })
  }

  closedOrders(id: string): Promise<unknown[]> {
    return this.get<unknown[]>("/ClosedOrders", { id })
  }

  async quote(id: string, symbol: string): Promise<{ bid: number; ask: number }> {
    const raw = await this.get<unknown>(this.paths.quote, { id, symbol })
    assertNoApiError(raw)
    const root = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
    const r = (root.result && typeof root.result === "object") ? root.result as Record<string, unknown> : root
    const bid = num(r.bid ?? r.Bid) ?? 0
    const ask = num(r.ask ?? r.Ask) ?? 0
    if (bid <= 0 || ask <= 0) {
      throw new MetatraderApiError(`Quote: invalid bid/ask for ${symbol}`, 200)
    }
    return { bid, ask }
  }

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
    const raw = await this.get<unknown>(this.paths.orderSend, {
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
    assertNoApiError(raw)
    const root = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
    const r = (root.result && typeof root.result === "object") ? root.result as Record<string, unknown> : root
    const ticket = num(r.ticket ?? r.Ticket ?? r.orderId ?? r.OrderID)
    if (!ticket || ticket <= 0) {
      throw new MetatraderApiError(`OrderSend returned no ticket`, 200)
    }
    return {
      ticket,
      openPrice: num(r.openPrice ?? r.OpenPrice ?? r.price ?? r.Price),
      lots: num(r.lots ?? r.Lots ?? r.volume ?? r.Volume),
      stopLoss: num(r.stoploss ?? r.StopLoss ?? r.sl ?? r.SL),
      takeProfit: num(r.takeprofit ?? r.TakeProfit ?? r.tp ?? r.TP),
    }
  }

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

const clientCache = new Map<MtPlatform, MetatraderApiClient>()

export function makeClientFromEnv(
  env: { get(name: string): string | undefined },
  platform: MtPlatform,
): MetatraderApiClient {
  const cached = clientCache.get(platform)
  if (cached) return cached

  const authHeader = resolveBasicAuthHeader(env)
  const baseUrl = platform === "MT5"
    ? (trimEnv(env.get("MT4API_MT5_BASE_URL")) || trimEnv(env.get("METATRADERAPI_BASE_URL")) || DEFAULT_MT5_BASE)
    : (trimEnv(env.get("MT4API_MT4_BASE_URL")) || trimEnv(env.get("METATRADERAPI_BASE_URL")) || DEFAULT_MT4_BASE)

  const client = new MetatraderApiClient(platform, authHeader, baseUrl)
  clientCache.set(platform, client)
  return client
}
