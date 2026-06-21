/**
 * FxSocket MT5 REST client for Deno edge functions.
 *
 * Account linking (v1): https://api.fxsocket.com/v1/docs
 *   POST /v1/accounts — link MT5 with login/password/server (X-API-Key only)
 *   GET  /v1/accounts/{id} — poll until status is connected
 *
 * Trading (per-account): https://fxsocket.com/docs#request-builder
 *   https://api.fxsocket.com/mt4/{account_id}/… or …/mt5/{account_id}/…
 */

export const FXSOCKET_DOCS_REQUEST_BUILDER = "https://fxsocket.com/docs#request-builder"
export const FXSOCKET_V1_DOCS_URL = "https://api.fxsocket.com/v1/docs#/"

export const FXSOCKET_DOCUMENTED_ENDPOINTS = [
  "GET /AccountSummary",
  "GET /OpenedOrders",
  "GET /OrderHistory",
  "GET /symbols",
  "GET /getQuote",
  "GET /PriceHistory",
  "GET /QuoteTicks",
  "GET /SymbolInfo",
  "GET /ServerTimezone",
  "GET /OrderCalcMargin",
  "GET /OrderCalcProfit",
  "POST /OrderSend",
  "POST /OrderModify",
  "POST /OrderClose",
] as const

const DEFAULT_BASE_URL = "https://api.fxsocket.com"

export class FxsocketApiError extends Error {
  status: number
  code?: string
  commandId?: number

  constructor(message: string, status: number, code?: string, commandId?: number) {
    super(message)
    this.name = "FxsocketApiError"
    this.status = status
    this.code = code
    this.commandId = commandId
  }
}

type EnvGetter = { get(name: string): string | undefined }

function trimEnv(v: string | undefined): string {
  return (v ?? "").trim()
}

export function getFxsocketBaseUrl(env: EnvGetter): string {
  const raw = trimEnv(env.get("FXSOCKET_BASE_URL")) || DEFAULT_BASE_URL
  return raw.replace(/\/+$/, "")
}

export function getFxsocketV1BaseUrl(env: EnvGetter): string {
  return `${getFxsocketBaseUrl(env)}/v1`
}

export function resolveFxsocketApiKey(env: EnvGetter): string {
  const key = trimEnv(env.get("FXSOCKET_API_KEY"))
  if (!key) {
    throw new FxsocketApiError(
      "FXSOCKET_API_KEY is not configured on the server. Set it in Supabase Edge secrets.",
      503,
      "CONFIG_MISSING",
    )
  }
  return key
}

export function isFxsocketConfigured(env: EnvGetter): boolean {
  try {
    resolveFxsocketApiKey(env)
    return true
  } catch {
    return false
  }
}

export interface FxsocketV1Account {
  id: string
  nickname: string
  platform: string
  server: string
  login: number
  status: string
  error: string
  created_at: string
}

export interface FxsocketAccountSummary {
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

export interface FxsocketQuote {
  symbol?: string
  bid?: number
  ask?: number
  time?: string
  last?: number
  volume?: number
}

/** OHLC bar from GET /PriceHistory — https://fxsocket.com/docs/mt5/market-data */
export interface FxsocketPriceBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  tickVolume?: number
  realVolume?: number
  spread?: number
}

/** Historical quote tick from GET /QuoteTicks (MT5 copy_ticks_range shape). */
export interface FxsocketQuoteTick {
  time: string
  bid: number
  ask: number
  timeMsc?: number
  last?: number
  volume?: number
}

export interface FxsocketOpenedOrder {
  ticket?: number
  symbol?: string
  type?: string
  kind?: string
  lots?: number
  openPrice?: number
  currentPrice?: number
  stopLoss?: number
  takeProfit?: number
  profit?: number
  comment?: string
  openTime?: string
}

export interface FxsocketOrderResult {
  success: boolean
  retcode?: number
  retcodeDescription?: string
  deal?: number
  order?: number
  volume?: number
  price?: number
  bid?: number
  ask?: number
  comment?: string
}

export interface FxsocketTerminalStatus {
  connected?: boolean
  tradeAllowed?: boolean
  serverTime?: string
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function parseErrorEnvelope(body: unknown): { message: string; code?: string; commandId?: number } {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>
    if (o.detail != null) {
      const detail = o.detail
      if (typeof detail === "string") return { message: detail, code: o.error != null ? String(o.error) : undefined }
      if (Array.isArray(detail)) return { message: detail.map(String).join("; ") }
    }
    const message = String(o.message ?? o.error ?? "FxSocket request failed")
    const code = o.error != null ? String(o.error) : undefined
    const commandId = num(o.command_id)
    return { message, code, commandId }
  }
  if (typeof body === "string" && body.trim()) return { message: body.trim() }
  return { message: "FxSocket request failed" }
}

export function normalizeV1Account(raw: unknown): FxsocketV1Account {
  const o = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
  return {
    id: o.id != null ? String(o.id) : "",
    nickname: o.nickname != null ? String(o.nickname) : "",
    platform: o.platform != null ? String(o.platform) : "",
    server: o.server != null ? String(o.server) : "",
    login: num(o.login) ?? 0,
    status: o.status != null ? String(o.status) : "",
    error: o.error != null ? String(o.error) : "",
    created_at: o.created_at != null ? String(o.created_at) : "",
  }
}

export function isV1AccountLinkError(v1: FxsocketV1Account): boolean {
  return v1.status.trim().toLowerCase() === "error"
}

/** v1 link status can stay "connecting" while the MT5 REST terminal is already usable. */
export function isV1AccountLinkPending(v1: FxsocketV1Account): boolean {
  const s = v1.status.trim().toLowerCase()
  return s === "connecting" || s === "pending" || s === "sent" || s === "starting" || s === ""
}

export function isAccountSummaryReady(summary: FxsocketAccountSummary): boolean {
  return summary.balance != null || summary.equity != null
}

export type FxsocketLinkReadiness =
  | { ready: true; summary: FxsocketAccountSummary; v1: FxsocketV1Account }
  | { ready: false; pending: true; v1: FxsocketV1Account }
  | { ready: false; pending: false; error: string; v1: FxsocketV1Account }

function normalizeV1Platform(platform?: string): "mt4" | "mt5" | undefined {
  const p = String(platform ?? "").trim().toUpperCase()
  if (p === "MT4") return "mt4"
  if (p === "MT5") return "mt5"
  return undefined
}

/** REST path segment for per-account trading API (`/mt4/{id}` or `/mt5/{id}`). */
export function accountApiPathSegment(platform?: string | null): "mt4" | "mt5" {
  return normalizeV1Platform(platform ?? "") ?? "mt5"
}

/** Build POST /v1/accounts body per OpenAPI schema V1CreateAccount. */
export function buildV1CreateAccountBody(args: {
  login: string | number
  password: string
  server: string
  nickname?: string
  platform?: string
}): Record<string, unknown> {
  const loginNum = Number(String(args.login).trim())
  if (!Number.isFinite(loginNum) || loginNum < 1) {
    throw new FxsocketApiError("Invalid MT login number", 400)
  }
  const body: Record<string, unknown> = {
    login: loginNum,
    password: args.password,
    server: args.server.trim(),
  }
  const nickname = args.nickname?.trim()
  if (nickname) body.nickname = nickname
  const platform = normalizeV1Platform(args.platform)
  if (platform) body.platform = platform
  return body
}

export function normalizeAccountSummary(raw: unknown): FxsocketAccountSummary {
  const o = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
  return {
    balance: num(o.balance),
    credit: num(o.credit),
    profit: num(o.profit),
    equity: num(o.equity),
    margin: num(o.margin),
    freeMargin: num(o.freeMargin ?? o.free_margin),
    marginLevel: num(o.marginLevel ?? o.margin_level),
    leverage: num(o.leverage),
    currency: o.currency != null ? String(o.currency) : undefined,
    type: o.type != null ? String(o.type) : undefined,
    isInvestor: o.isInvestor === true || o.is_investor === true,
  }
}

export function normalizeOrderResponse(raw: unknown): FxsocketOrderResult {
  const o = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
  return {
    success: o.success === true,
    retcode: num(o.retcode),
    retcodeDescription: o.retcodeDescription != null ? String(o.retcodeDescription) : undefined,
    deal: num(o.deal),
    order: num(o.order),
    volume: num(o.volume),
    price: num(o.price),
    bid: num(o.bid),
    ask: num(o.ask),
    comment: o.comment != null ? String(o.comment) : undefined,
  }
}

export function trimPreview(value: unknown, maxLen = 400): unknown {
  if (value == null) return value
  const text = JSON.stringify(value)
  if (text.length <= maxLen) return value
  return { _preview: `${text.slice(0, maxLen)}…` }
}

function parsePriceBar(raw: unknown): FxsocketPriceBar | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const time = o.time != null ? String(o.time) : ""
  const open = num(o.open)
  const high = num(o.high)
  const low = num(o.low)
  const close = num(o.close)
  if (!time || open == null || high == null || low == null || close == null) return null
  return {
    time,
    open,
    high,
    low,
    close,
    tickVolume: num(o.tickVolume ?? o.tick_volume),
    realVolume: num(o.realVolume ?? o.real_volume),
    spread: num(o.spread),
  }
}

export function parsePriceHistoryResponse(raw: unknown): FxsocketPriceBar[] {
  if (!Array.isArray(raw)) return []
  return raw.map(parsePriceBar).filter((b): b is FxsocketPriceBar => b != null)
}

function parseQuoteTick(raw: unknown): FxsocketQuoteTick | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const bid = num(o.bid)
  const ask = num(o.ask)
  if (bid == null || ask == null) return null
  const time = o.time != null ? String(o.time) : ""
  const timeMsc = num(o.timeMsc ?? o.time_msc ?? o.timeMs ?? o.time_ms)
  const ts = time || (timeMsc != null ? String(timeMsc) : "")
  if (!ts) return null
  return {
    time: time || new Date(timeMsc!).toISOString(),
    bid,
    ask,
    timeMsc: timeMsc ?? undefined,
    last: num(o.last),
    volume: num(o.volume),
  }
}

export function parseQuoteTicksResponse(raw: unknown): FxsocketQuoteTick[] {
  if (!Array.isArray(raw)) return []
  return raw.map(parseQuoteTick).filter((t): t is FxsocketQuoteTick => t != null)
}

function unwrapOrderList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== "object") return []
  const o = raw as Record<string, unknown>
  for (const key of [
    "orders", "Orders", "deals", "Deals", "positions", "Positions",
    "history", "History", "items", "Items", "data", "Data", "result", "Result",
  ]) {
    const v = o[key]
    if (Array.isArray(v)) return v
  }
  return []
}

export class FxsocketClient {
  private apiKey: string
  private baseUrl: string
  private v1BaseUrl: string

  constructor(env: EnvGetter) {
    this.apiKey = resolveFxsocketApiKey(env)
    this.baseUrl = getFxsocketBaseUrl(env)
    this.v1BaseUrl = getFxsocketV1BaseUrl(env)
  }

  accountBase(accountId: string, platform?: string | null): string {
    const id = String(accountId ?? "").trim()
    if (!id) throw new FxsocketApiError("account_id required", 400)
    const segment = accountApiPathSegment(platform)
    return `${this.baseUrl}/${segment}/${encodeURIComponent(id)}`
  }

  private async request(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const timeoutMs = init.timeoutMs ?? 60_000
    const headers = new Headers(init.headers)
    headers.set("X-API-Key", this.apiKey)
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(url, { ...init, headers, signal: controller.signal })
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new FxsocketApiError("FxSocket request timed out", 504, "TIMEOUT")
      }
      throw new FxsocketApiError(e instanceof Error ? e.message : "FxSocket network error", 502)
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    let body: unknown = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }

    if (!res.ok) {
      const err = parseErrorEnvelope(body)
      if (res.status === 404 && (url.includes("/mt5/") || url.includes("/mt4/"))) {
        throw new FxsocketApiError(
          "FxSocket account or endpoint not found. Check the account UUID and that the terminal is running.",
          404,
          err.code,
          err.commandId,
        )
      }
      throw new FxsocketApiError(err.message, res.status, err.code, err.commandId)
    }
    return body
  }

  /** Link MT4/MT5 account via POST /v1/accounts (API key only). */
  async connectAccount(args: {
    login: string | number
    password: string
    server: string
    label?: string
    platform?: string
  }): Promise<{ accountId: string; raw: unknown; v1Account: FxsocketV1Account }> {
    const payload = buildV1CreateAccountBody({
      login: args.login,
      password: args.password,
      server: args.server,
      nickname: args.label,
      platform: args.platform,
    })
    const raw = await this.request(`${this.v1BaseUrl}/accounts`, {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 120_000,
    })
    const v1Account = normalizeV1Account(raw)
    if (!v1Account.id) {
      throw new FxsocketApiError("FxSocket link succeeded but no account id was returned.", 502, "CONNECT_NO_ID")
    }
    return { accountId: v1Account.id, raw, v1Account }
  }

  async listAccounts(): Promise<FxsocketV1Account[]> {
    const raw = await this.request(`${this.v1BaseUrl}/accounts`, { method: "GET" })
    return Array.isArray(raw) ? raw.map(normalizeV1Account) : []
  }

  async getV1Account(accountId: string): Promise<FxsocketV1Account> {
    const raw = await this.request(
      `${this.v1BaseUrl}/accounts/${encodeURIComponent(accountId)}`,
      { method: "GET" },
    )
    return normalizeV1Account(raw)
  }

  /**
   * Probe MT5 AccountSummary for readiness — do not rely on v1 status alone.
   * The v1 link record can lag behind a terminal that already answers REST calls.
   */
  async resolveLinkReadiness(accountId: string): Promise<FxsocketLinkReadiness> {
    const v1 = await this.getV1Account(accountId)
    if (isV1AccountLinkError(v1)) {
      return {
        ready: false,
        pending: false,
        error: v1.error || "FxSocket terminal connection failed",
        v1,
      }
    }

    const apiPlatform = v1.platform || undefined

    try {
      const summary = await this.accountSummary(accountId, apiPlatform)
      if (isAccountSummaryReady(summary)) {
        return { ready: true, summary, v1 }
      }
    } catch (e) {
      if (e instanceof FxsocketApiError && e.status === 401) throw e
    }

    if (isV1AccountLinkPending(v1)) {
      return { ready: false, pending: true, v1 }
    }

    return {
      ready: false,
      pending: false,
      error: "Could not fetch account summary from the broker terminal",
      v1,
    }
  }

  async accountSummary(accountId: string, platform?: string | null): Promise<FxsocketAccountSummary> {
    const raw = await this.request(`${this.accountBase(accountId, platform)}/AccountSummary`, { method: "GET" })
    return normalizeAccountSummary(raw)
  }

  async openedOrders(accountId: string, platform?: string | null): Promise<FxsocketOpenedOrder[]> {
    const raw = await this.request(`${this.accountBase(accountId, platform)}/OpenedOrders`, { method: "GET" })
    return Array.isArray(raw) ? raw as FxsocketOpenedOrder[] : []
  }

  async getQuote(accountId: string, symbol: string, platform?: string | null): Promise<FxsocketQuote> {
    const q = encodeURIComponent(symbol.trim())
    const raw = await this.request(`${this.accountBase(accountId, platform)}/getQuote?symbol=${q}`, { method: "GET" })
    return (raw && typeof raw === "object") ? raw as FxsocketQuote : {}
  }

  async symbolInfo(accountId: string, symbol: string, platform?: string | null): Promise<Record<string, unknown>> {
    const q = encodeURIComponent(symbol.trim())
    const raw = await this.request(`${this.accountBase(accountId, platform)}/SymbolInfo?symbol=${q}`, { method: "GET" })
    return (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
  }

  async symbols(accountId: string, platform?: string | null): Promise<string[]> {
    const raw = await this.request(`${this.accountBase(accountId, platform)}/symbols`, { method: "GET" })
    return Array.isArray(raw) ? raw.map(String) : []
  }

  async orderHistory(accountId: string, from: string, to: string, platform?: string | null): Promise<unknown[]> {
    const qFrom = encodeURIComponent(from.trim())
    const qTo = encodeURIComponent(to.trim())
    const raw = await this.request(
      `${this.accountBase(accountId, platform)}/OrderHistory?from=${qFrom}&to=${qTo}`,
      { method: "GET", timeoutMs: 90_000 },
    )
    return unwrapOrderList(raw)
  }

  async positionHistory(accountId: string, from: string, to: string, platform?: string | null): Promise<unknown[]> {
    const qFrom = encodeURIComponent(from.trim())
    const qTo = encodeURIComponent(to.trim())
    const raw = await this.request(
      `${this.accountBase(accountId, platform)}/PositionHistory?from=${qFrom}&to=${qTo}`,
      { method: "GET", timeoutMs: 90_000 },
    )
    return unwrapOrderList(raw)
  }

  async priceHistory(
    accountId: string,
    args: { symbol: string; timeframe: string; from: string; to: string },
    platform?: string | null,
  ): Promise<FxsocketPriceBar[]> {
    const params = new URLSearchParams({
      symbol: args.symbol.trim(),
      timeframe: args.timeframe.trim(),
      from: args.from.trim(),
      to: args.to.trim(),
    })
    const raw = await this.request(
      `${this.accountBase(accountId, platform)}/PriceHistory?${params.toString()}`,
      { method: "GET", timeoutMs: 90_000 },
    )
    return parsePriceHistoryResponse(raw)
  }

  /** Historical bid/ask ticks for backtesting (GET /QuoteTicks). */
  async quoteTicks(
    accountId: string,
    args: { symbol: string; from: string; to: string },
    platform?: string | null,
  ): Promise<FxsocketQuoteTick[]> {
    const params = new URLSearchParams({
      symbol: args.symbol.trim(),
      from: args.from.trim(),
      to: args.to.trim(),
    })
    const raw = await this.request(
      `${this.accountBase(accountId, platform)}/QuoteTicks?${params.toString()}`,
      { method: "GET", timeoutMs: 120_000 },
    )
    return parseQuoteTicksResponse(raw)
  }

  async serverTimezone(accountId: string, platform?: string | null): Promise<Record<string, unknown>> {
    const raw = await this.request(`${this.accountBase(accountId, platform)}/ServerTimezone`, { method: "GET" })
    return (raw && typeof raw === "object") ? raw as Record<string, unknown> : {}
  }

  async orderSend(accountId: string, payload: Record<string, unknown>, platform?: string | null): Promise<FxsocketOrderResult> {
    const raw = await this.request(`${this.accountBase(accountId, platform)}/OrderSend`, {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 90_000,
    })
    return normalizeOrderResponse(raw)
  }

  async orderModify(accountId: string, payload: Record<string, unknown>, platform?: string | null): Promise<FxsocketOrderResult> {
    const raw = await this.request(`${this.accountBase(accountId, platform)}/OrderModify`, {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 90_000,
    })
    return normalizeOrderResponse(raw)
  }

  async orderClose(accountId: string, payload: Record<string, unknown>, platform?: string | null): Promise<FxsocketOrderResult> {
    const raw = await this.request(`${this.accountBase(accountId, platform)}/OrderClose`, {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 90_000,
    })
    return normalizeOrderResponse(raw)
  }

  /** Unlink account via DELETE /v1/accounts/{id}. */
  async deleteAccount(accountId: string): Promise<void> {
    try {
      await this.request(
        `${this.v1BaseUrl}/accounts/${encodeURIComponent(accountId)}`,
        { method: "DELETE", timeoutMs: 30_000 },
      )
    } catch (e) {
      console.warn("[fxsocketClient] deleteAccount failed:", e instanceof Error ? e.message : e)
    }
  }

  /** Poll until AccountSummary succeeds (terminal ready), not only v1 status connected. */
  async pollUntilReady(
    accountId: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<{ summary: FxsocketAccountSummary; v1Account: FxsocketV1Account; terminal?: FxsocketTerminalStatus }> {
    const timeoutMs = opts?.timeoutMs ?? 180_000
    const intervalMs = opts?.intervalMs ?? 3_000
    const started = Date.now()
    let lastV1: FxsocketV1Account | null = null

    while (Date.now() - started < timeoutMs) {
      const readiness = await this.resolveLinkReadiness(accountId)
      lastV1 = readiness.v1
      if (readiness.ready) {
        return { summary: readiness.summary, v1Account: readiness.v1, terminal: { connected: true } }
      }
      if (!readiness.pending) {
        throw new FxsocketApiError(
          readiness.error || "FxSocket terminal connection failed",
          502,
          "CONNECT_ERROR",
        )
      }
      await new Promise(r => setTimeout(r, intervalMs))
    }

    const msg = lastV1?.error
      || `Terminal did not reach connected status (last: ${lastV1?.status || "unknown"})`
    throw new FxsocketApiError(msg, 504, "CONNECT_TIMEOUT")
  }
}

export function makeFxsocketClientFromEnv(env: EnvGetter): FxsocketClient {
  return new FxsocketClient(env)
}
