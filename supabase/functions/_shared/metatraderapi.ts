/**
 * MT4/MT5 REST client (mt4api.dev) for Deno edge functions.
 * Basic Auth + platform-specific hosts. See docs/mt4api-endpoint-map.md.
 */

import { ingestMtHistoryRows, type MtHistoryProfile } from "./mtTradeFields.ts"
import { isMtBridgeGlitchMessage } from "./brokerConnectError.ts"

const DEFAULT_MT5_BASE = "https://mt5.mt4api.dev"
const DEFAULT_MT4_BASE = "https://mt4.mt4api.dev"

export type MtPlatform = "MT4" | "MT5"

export interface BrokerSearchResult {
  name?: string
  access?: string[]
}

export interface BrokerSearchCompany {
  companyName?: string
  results?: BrokerSearchResult[]
}

export function extractServerNamesFromSearch(companies: BrokerSearchCompany[]): string[] {
  const names = new Set<string>()
  for (const c of companies) {
    for (const r of c.results ?? []) {
      const n = (r.name ?? "").trim()
      if (n) names.add(n)
    }
  }
  return [...names]
}

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

/** Strip copy-paste junk from env URLs, e.g. `(https://mt4.mt4api.dev/)` → `https://mt4.mt4api.dev` */
function normalizeBaseUrl(raw: string, fallback: string): string {
  let u = trimEnv(raw)
  if (!u) return fallback.replace(/\/+$/, "")
  u = u.replace(/^[<\[(]+/, "").replace(/[>\])]+$/, "")
  u = u.replace(/\/+$/, "")
  try {
    const parsed = new URL(u.includes("://") ? u : `https://${u}`)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    console.warn(`[metatraderapi] invalid base URL "${raw.slice(0, 80)}", using default`)
    return fallback.replace(/\/+$/, "")
  }
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

export function isCheckConnectOk(body: unknown): boolean {
  if (body === true) return true
  if (body === false) return false
  if (typeof body === "number") return body > 0
  if (typeof body === "string") {
    const s = body.trim().toLowerCase()
    if (!s) return false
    if (s === "true" || s === "ok" || s === "connected" || s === "yes" || s === "1") return true
    if (
      s === "false" || s === "0" || s.includes("not connected") || s.includes("disconnected") || s.includes("notconnected")
    ) {
      return false
    }
    return true
  }
  if (body && typeof body === "object") {
    const r = body as Record<string, unknown>
    const nested = r.result ?? r.Result
    if (nested !== undefined && nested !== r) return isCheckConnectOk(nested)
    const flag = r.connected ?? r.Connected ?? r.isConnected ?? r.IsConnected
    if (typeof flag === "boolean") return flag
    if (typeof flag === "string" || typeof flag === "number") return isCheckConnectOk(flag)
  }
  return true
}

export function isMtSessionGoneMessage(message: string): boolean {
  const m = message.trim().toLowerCase()
  if (!m) return false
  return (
    m.includes("client with id")
    || m.includes("client not found")
    || (m.includes("not found") && (m.includes("client") || m.includes("id =")))
    || m.includes("unknown client")
    || m.includes("session not found")
    || m.includes("account not found")
  )
}

export function isMtSessionGoneError(err: unknown): boolean {
  if (err instanceof MetatraderApiError) return isMtSessionGoneMessage(err.message)
  if (err instanceof Error) return isMtSessionGoneMessage(err.message)
  return isMtSessionGoneMessage(String(err))
}

export function isTransientMtApiError(err: unknown): boolean {
  if (err instanceof MetatraderApiError) {
    const s = err.status
    if (s === 502 || s === 503 || s === 504) return true
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /timeout|fetch failed|network error|connection reset|econnreset|econnrefused|socket hang up|epipe|ehostunreach/.test(msg)
}

/** OrderSend/CheckConnect rejected because the MT terminal session is offline. */
export function isBrokerDisconnectedMessage(message: string): boolean {
  const m = message.trim().toLowerCase()
  if (!m) return false
  if (isMtSessionGoneMessage(message)) return true
  return m.includes("not connected") || m.includes("broker session is not connected")
}

export const MT_SESSION_EXPIRED_HINT =
  "Trading session expired on the broker API. In Account Configuration, use Reconnect and enter your MT password (or remove and link the account again)."

export type KeepSessionAliveStatus =
  | "alive"
  | "session_gone"
  | "token_reconnect_failed"

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
    this.baseUrl = normalizeBaseUrl(baseUrl ?? "", defaultBase)
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
    assertNoApiError(raw)
    return parseToken(raw, args.id)
  }

  /** Reconnect using stored token (no password). */
  async connectByToken(id: string): Promise<void> {
    const raw = await this.get<unknown>("/ConnectByToken", { id })
    assertNoApiError(raw)
  }

  async ensureConnected(id: string): Promise<void> {
    const alive = await this.keepSessionAlive(id)
    if (!alive) throw new MetatraderApiError("Broker session is not connected", 502)
  }

  /** Ping session; ConnectByToken only when the session still exists on the bridge. */
  async keepSessionAlive(id: string): Promise<boolean> {
    const status = await this.keepSessionAliveDetailed(id)
    return status === "alive"
  }

  async keepSessionAliveDetailed(id: string): Promise<KeepSessionAliveStatus> {
    try {
      await this.checkConnect(id)
      return "alive"
    } catch (first) {
      if (isMtSessionGoneError(first)) return "session_gone"
    }
    const MAX_RETRIES = 3
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.connectByToken(id)
        await this.checkConnect(id)
        return "alive"
      } catch (err) {
        if (isMtSessionGoneError(err)) return "session_gone"
        if (attempt < MAX_RETRIES - 1 && isTransientMtApiError(err)) {
          const jitterMs = 1000 + Math.random() * 2000
          await new Promise(r => setTimeout(r, jitterMs))
          continue
        }
        return "token_reconnect_failed"
      }
    }
    return "token_reconnect_failed"
  }

  /**
   * CheckConnect alone can report "connected" while OrderSend still fails with
   * "Not connected (:login)". Confirm the terminal can serve trading APIs.
   */
  async verifyTradingReady(id: string): Promise<boolean> {
    if (!await this.keepSessionAlive(id)) return false
    try {
      const summary = await this.accountSummary(id)
      const hasSummary =
        summary != null
        && (summary.balance != null || summary.equity != null || summary.currency)
      if (!hasSummary) return false
      await this.openedOrders(id)
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isBrokerDisconnectedMessage(msg) || isMtSessionGoneError(err)) return false
      if (isMtBridgeGlitchMessage(msg)) return true
      return false
    }
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

  async checkConnect(id: string): Promise<void> {
    const raw = await this.get<unknown>("/CheckConnect", { id })
    assertNoApiError(raw)
    if (!isCheckConnectOk(raw)) {
      throw new MetatraderApiError("Broker session is not connected", 502)
    }
  }

  /** Broker/server discovery — `company` must be at least 4 characters. */
  async searchBrokers(company: string): Promise<BrokerSearchCompany[]> {
    const q = company.trim()
    if (q.length < 4) {
      throw new MetatraderApiError("Search company must be at least 4 characters", 400)
    }
    const raw = await this.get<unknown>("/Search", { company: q })
    if (!Array.isArray(raw)) return []
    return raw as BrokerSearchCompany[]
  }

  async accountSummary(id: string): Promise<AccountSummary> {
    const raw = await this.get<unknown>("/AccountSummary", { id })
    assertNoApiError(raw)
    return normalizeAccountSummary(raw)
  }

  async openedOrders(id: string): Promise<unknown[]> {
    const raw = await this.get<unknown>("/OpenedOrders", { id })
    return MetatraderApiClient.parseOrderList(raw)
  }

  async closedOrders(id: string): Promise<unknown[]> {
    const raw = await this.get<unknown>("/ClosedOrders", { id })
    return MetatraderApiClient.parseOrderList(raw)
  }

  /** yyyy-MM-ddTHH:mm:ss for mt4api.dev / mt5.mt4api.dev query params. */
  static formatDateTime(d: Date): string {
    return d.toISOString().slice(0, 19)
  }

  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    const raw = await this.get<unknown>("/OrderHistory", { id, from, to })
    return MetatraderApiClient.parseOrderList(raw)
  }

  async historyPositions(id: string, from: string, to: string): Promise<unknown[]> {
    const raw = await this.get<unknown>("/HistoryPositions", { id, from, to })
    return MetatraderApiClient.parseOrderList(raw)
  }

  async orderHistoryPage(
    id: string,
    from: string,
    to: string,
    pageNumber: number,
    ordersPerPage = 1000,
  ): Promise<{ orders: unknown[]; pagesCount: number }> {
    const raw = await this.get<unknown>("/OrderHistoryPagination", {
      id,
      from,
      to,
      pageNumber,
      ordersPerPage,
    })
    return MetatraderApiClient.parsePaginationOrders(raw)
  }

  /**
   * Closed history for charts/stats (`dashboard`) or Trades page (`trades`).
   * Profiles use different merge + field parsing — do not share one path.
   */
  async closedOrdersHistory(
    id: string,
    from: string,
    to: string,
    profile: MtHistoryProfile = "dashboard",
  ): Promise<unknown[]> {
    const byKey = new Map<string, Record<string, unknown>>()
    const ingest = (rows: unknown[]) => ingestMtHistoryRows(byKey, rows, profile)

    try {
      let page = 0
      let pagesCount = 1
      while (page < pagesCount && page < 250) {
        const { orders, pagesCount: totalPages } = await this.orderHistoryPage(id, from, to, page)
        ingest(orders)
        pagesCount = Math.max(1, totalPages)
        if (orders.length === 0) break
        page += 1
      }
    } catch {
      /* pagination optional on some builds */
    }

    const settled = profile === "dashboard"
      ? await Promise.allSettled([
        this.closedOrders(id),
        this.historyPositions(id, from, to),
        this.orderHistory(id, from, to),
      ])
      : await Promise.allSettled([
        this.historyPositions(id, from, to),
        this.orderHistory(id, from, to),
      ])

    for (const r of settled) {
      if (r.status === "fulfilled") ingest(r.value)
    }
    return [...byKey.values()]
  }

  /**
   * Recent closed history only — last pagination page(s) + session closed orders.
   * Page 0 is the oldest slice of the range; newest deals are on the last page(s).
   */
  async closedOrdersHistoryLite(
    id: string,
    from: string,
    to: string,
    profile: MtHistoryProfile = "dashboard",
    maxPages = 2,
    ordersPerPage = 200,
  ): Promise<unknown[]> {
    const byKey = new Map<string, Record<string, unknown>>()
    const ingest = (rows: unknown[]) => ingestMtHistoryRows(byKey, rows, profile)

    try {
      ingest(await this.closedOrders(id))
    } catch {
      /* optional on some sessions */
    }

    try {
      const probe = await this.orderHistoryPage(id, from, to, 0, ordersPerPage)
      const pagesCount = Math.max(1, probe.pagesCount)

      if (pagesCount === 1) {
        ingest(probe.orders)
      } else {
        const startPage = Math.max(0, pagesCount - maxPages)
        for (let page = startPage; page < pagesCount; page++) {
          const { orders } = page === 0
            ? probe
            : await this.orderHistoryPage(id, from, to, page, ordersPerPage)
          ingest(orders)
        }
      }

      if (byKey.size > 0) return [...byKey.values()]
    } catch {
      /* fall through to single request */
    }

    try {
      ingest(await this.orderHistory(id, from, to))
    } catch {
      /* ignore */
    }
    return [...byKey.values()]
  }

  static parseOrderList(raw: unknown): unknown[] {
    assertNoApiError(raw)
    if (Array.isArray(raw)) return raw
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>
      if (Array.isArray(r.result)) return r.result
      if (Array.isArray(r.Result)) return r.Result
      if (Array.isArray(r.orders)) return r.orders
      if (Array.isArray(r.Orders)) return r.Orders
      const nested = r.result ?? r.Result
      if (nested && typeof nested === "object") {
        const pr = nested as Record<string, unknown>
        const orders = pr.Orders ?? pr.orders
        if (Array.isArray(orders)) return orders
      }
    }
    return []
  }

  static parsePaginationOrders(raw: unknown): { orders: unknown[]; pagesCount: number } {
    assertNoApiError(raw)
    if (raw && typeof raw === "object") {
      const root = raw as Record<string, unknown>
      const result = root.result ?? root.Result
      if (result && typeof result === "object") {
        const pr = result as Record<string, unknown>
        const orders = pr.Orders ?? pr.orders
        return {
          orders: Array.isArray(orders) ? orders : [],
          pagesCount: Number(pr.PagesCount ?? pr.pagesCount ?? 1) || 1,
        }
      }
    }
    return { orders: MetatraderApiClient.parseOrderList(raw), pagesCount: 1 }
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

  async orderModify(id: string, args: {
    ticket: number
    stoploss?: number
    takeprofit?: number
    price?: number
  }): Promise<{ stopLoss?: number; takeProfit?: number }> {
    const raw = await this.get<unknown>(this.paths.orderModify, {
      id,
      ticket: args.ticket,
      stoploss: args.stoploss ?? 0,
      takeprofit: args.takeprofit ?? 0,
      price: args.price ?? 0,
    })
    assertNoApiError(raw)
    const root = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
    const r = (root.result && typeof root.result === "object") ? root.result as Record<string, unknown> : root
    return {
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
  const defaultBase = platform === "MT5" ? DEFAULT_MT5_BASE : DEFAULT_MT4_BASE
  const rawBase = platform === "MT5"
    ? (trimEnv(env.get("MT4API_MT5_BASE_URL")) || trimEnv(env.get("METATRADERAPI_BASE_URL")))
    : (trimEnv(env.get("MT4API_MT4_BASE_URL")) || trimEnv(env.get("METATRADERAPI_BASE_URL")))
  const baseUrl = normalizeBaseUrl(rawBase, defaultBase)

  const client = new MetatraderApiClient(platform, authHeader, baseUrl)
  clientCache.set(platform, client)
  return client
}
