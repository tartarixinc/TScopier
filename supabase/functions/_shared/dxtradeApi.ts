/**
 * DXtrade REST helpers for edge functions (white-label forex/CFD platform).
 *
 * Every broker hosts its own server, so the trader supplies the URL. That makes the URL an SSRF
 * surface: `normalizeDxtradeServerUrl` + `assertPublicDxtradeHost` must run before any request.
 *
 * Auth: `POST /login` returns a session token sent as `Authorization: DXAPI <token>`. A non-empty
 * User-Agent is required or the gateway answers 403. Login is limited to about one per second per IP.
 */

export class DxtradeError extends Error {
  status: number
  code: string | undefined
  constructor(message: string, status = 0, code?: string) {
    super(message)
    this.name = "DxtradeError"
    this.status = status
    this.code = code
  }
}

const USER_AGENT = "TScopier/1.0 (+https://tscopier.ai)"
const REQUEST_TIMEOUT_MS = 15_000
const API_PATH = "/dxsca-web"

// ── Server URL validation (SSRF guard) ─────────────────────────────────────

const BLOCKED_HOST_SUFFIXES = [
  ".local", ".localhost", ".internal", ".localdomain", ".lan", ".home", ".corp", ".intranet", ".private",
]

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public IPv4/IPv6 addresses. */
export function isPrivateIp(ip: string): boolean {
  const value = ip.trim().toLowerCase()
  if (isIpv4Literal(value)) {
    const [a, b] = value.split(".").map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (value.includes(":")) {
    if (value === "::" || value === "::1") return true
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("ff")) return true
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
    if (mapped) return isPrivateIp(mapped[1])
    return false
  }
  return false
}

export type DxtradeUrlResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * Accepts `https://host`, `https://host/` or `https://host/dxsca-web` and returns
 * `https://host/dxsca-web`. Rejects plain http, credentials, odd ports, IP literals, single-label
 * and internal-looking host names.
 */
export function normalizeDxtradeServerUrl(input: string): DxtradeUrlResult {
  const raw = String(input ?? "").trim()
  if (!raw) return { ok: false, error: "Enter your broker's DXtrade server URL" }
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false, error: "That server URL is not valid" }
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "The DXtrade server URL must start with https://" }
  if (parsed.username || parsed.password) return { ok: false, error: "Remove the username or password from the server URL" }
  if (parsed.port && parsed.port !== "443") return { ok: false, error: "The DXtrade server URL must use the standard HTTPS port" }
  if (parsed.search || parsed.hash) return { ok: false, error: "Remove the query string from the server URL" }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "")
  if (!host || host.includes(":") || isIpv4Literal(host) || /^\[/.test(host)) {
    return { ok: false, error: "Use your broker's host name, not an IP address" }
  }
  if (!host.includes(".") || host === "localhost" || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return { ok: false, error: "That server URL is not a public broker address" }
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { ok: false, error: "That server URL is not valid" }
  }

  const path = parsed.pathname.replace(/\/+$/, "")
  if (path !== "" && path.toLowerCase() !== API_PATH) {
    return { ok: false, error: "The server URL should look like https://your-broker.com/dxsca-web" }
  }
  return { ok: true, url: `https://${host}${API_PATH}` }
}

/** Reject hosts whose DNS answers point at private space. Skipped when the runtime cannot resolve DNS. */
export async function assertPublicDxtradeHost(serverUrl: string): Promise<void> {
  const host = new URL(serverUrl).hostname
  const resolver = (globalThis as { Deno?: { resolveDns?: (q: string, t: string) => Promise<string[]> } }).Deno?.resolveDns
  if (!resolver) return
  const answers: string[] = []
  for (const type of ["A", "AAAA"]) {
    try {
      answers.push(...await resolver(host, type))
    } catch {
      // No record of this type, or DNS is not permitted here.
    }
  }
  if (answers.some(isPrivateIp)) {
    throw new DxtradeError("That server URL resolves to a private address and cannot be used", 400)
  }
}

// ── HTTP + session ─────────────────────────────────────────────────────────

type Json = Record<string, unknown>

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}
}

export function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** List responses are either a bare array or an object wrapping it under a named key. */
export function rows(data: unknown, ...keys: string[]): Json[] {
  if (Array.isArray(data)) return data.filter(item => item && typeof item === "object") as Json[]
  const obj = record(data)
  for (const key of keys) {
    const inner = obj[key]
    if (Array.isArray(inner)) return inner.filter(item => item && typeof item === "object") as Json[]
  }
  return []
}

export interface DxtradeCredentials {
  serverUrl: string
  username: string
  domain: string
  password: string
}

type Session = { token: string; expiresAt: number }
const sessions = new Map<string, Session>()
const loginChains = new Map<string, Promise<Session>>()
let lastLoginAt = 0

function sessionKey(c: DxtradeCredentials): string {
  return `${c.serverUrl}|${c.username.toLowerCase()}@${c.domain.toLowerCase()}`
}

function parseTimeoutMs(value: unknown): number {
  const text = String(value ?? "").trim()
  const interval = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/.exec(text)
  if (interval) {
    const days = Number(interval[1] ?? 0)
    return (((days * 24 + Number(interval[2])) * 60 + Number(interval[3])) * 60 + Number(interval[4])) * 1000
  }
  const date = Date.parse(text)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  const seconds = Number(text)
  if (Number.isFinite(seconds) && seconds > 0) return seconds > 100_000 ? seconds : seconds * 1000
  return 5 * 60_000
}

async function rawFetch(
  serverUrl: string,
  path: string,
  init: { method: string; token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    ...(init.headers ?? {}),
  }
  if (init.token) headers.Authorization = `DXAPI ${init.token}`
  let body: string | undefined
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(init.body)
  }
  let response: Response
  try {
    response = await fetch(`${serverUrl}${path}`, {
      method: init.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError"
    throw new DxtradeError(timedOut ? "The broker's DXtrade server did not answer in time" : "Could not reach the broker's DXtrade server", 0)
  }
  if (response.status >= 300 && response.status < 400) {
    throw new DxtradeError("The broker's DXtrade server redirected the request. Check the server URL.", response.status)
  }
  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!response.ok) {
    const err = record(data)
    const description = String(err.description ?? err.message ?? err.errorMessage ?? "").trim()
    throw new DxtradeError(description || `DXtrade request failed (${response.status})`, response.status, err.errorCode == null ? undefined : String(err.errorCode))
  }
  return { status: response.status, data, headers: response.headers }
}

async function login(creds: DxtradeCredentials): Promise<Session> {
  const key = sessionKey(creds)
  const inflight = loginChains.get(key)
  if (inflight) return inflight
  const run = (async () => {
    const wait = lastLoginAt + 1100 - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    lastLoginAt = Date.now()
    const { data } = await rawFetch(creds.serverUrl, "/login", {
      method: "POST",
      body: { username: creds.username, domain: creds.domain, password: creds.password },
    })
    const payload = record(data)
    const token = String(payload.sessionToken ?? "").trim()
    if (!token) throw new DxtradeError("The broker's DXtrade server did not return a session", 0)
    const ttl = parseTimeoutMs(payload.timeout)
    const session = { token, expiresAt: Date.now() + Math.max(30_000, ttl * 0.8) }
    sessions.set(key, session)
    return session
  })().finally(() => loginChains.delete(key))
  loginChains.set(key, run)
  return run
}

/** Authenticated request with one transparent re-login on 401. */
export async function dxRequest(
  creds: DxtradeCredentials,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ data: unknown; headers: Headers }> {
  const key = sessionKey(creds)
  let session = sessions.get(key)
  if (!session || session.expiresAt <= Date.now()) session = await login(creds)
  try {
    const { data, headers } = await rawFetch(creds.serverUrl, path, { method: init.method ?? "GET", token: session.token, body: init.body, headers: init.headers })
    return { data, headers }
  } catch (error) {
    if (error instanceof DxtradeError && error.status === 401) {
      sessions.delete(key)
      const fresh = await login(creds)
      const { data, headers } = await rawFetch(creds.serverUrl, path, { method: init.method ?? "GET", token: fresh.token, body: init.body, headers: init.headers })
      return { data, headers }
    }
    throw error
  }
}

export function friendlyDxtradeError(error: unknown): string {
  if (error instanceof DxtradeError) {
    if (error.status === 401) return "The broker rejected this username, domain or password."
    if (error.status === 403) return "The broker's DXtrade server blocked the request. Ask your broker to enable API access."
    if (error.status === 429) return "The broker's DXtrade server is rate limiting requests. Try again in a moment."
    if (error.status === 500 && error.code === "110") {
      return "The broker refused the login. Your password may have expired or two-factor sign-in may be required. Log in on the broker's web platform first."
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

// ── Accounts ───────────────────────────────────────────────────────────────

export interface DxtradeAccountInfo {
  account: string
  baseCurrency: string
  status: string
  isPositionBased: boolean | undefined
}

export async function dxtradeAccounts(creds: DxtradeCredentials): Promise<DxtradeAccountInfo[]> {
  const user = `${creds.username}@${creds.domain}`
  const { data } = await dxRequest(creds, `/users/${encodeURIComponent(user)}`)
  const out: DxtradeAccountInfo[] = []
  const users = Array.isArray(data) ? data : rows(data, "users")
  const candidates = users.length ? users : [record(data)]
  for (const candidate of candidates) {
    for (const account of rows(record(candidate).accounts)) {
      const code = String(account.account ?? "").trim()
      if (!code) continue
      out.push({
        account: code,
        baseCurrency: String(account.baseCurrency ?? "").trim() || "USD",
        status: String(account.accountStatus ?? "").trim().toUpperCase(),
        isPositionBased: typeof account.isPositionBased === "boolean"
          ? account.isPositionBased
          : (String(account.isPositionBased ?? "").toLowerCase() === "true" ? true : String(account.isPositionBased ?? "").toLowerCase() === "false" ? false : undefined),
      })
    }
  }
  return out
}

/** Stable per-account id. Hashes server, login and account code so the plain values never leak. */
export async function dxtradeFingerprint(serverUrl: string, username: string, domain: string, account: string): Promise<string> {
  const text = `${serverUrl.toLowerCase()}|${username.toLowerCase()}@${domain.toLowerCase()}|${account}`
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16)
}

// ── Account state ──────────────────────────────────────────────────────────

export interface DxtradeSnapshot {
  balance: number | undefined
  equity: number | undefined
  profit: number | undefined
  margin: number | undefined
  freeMargin: number | undefined
  currency: string
  canTrade: boolean
  openTrades: number
  status: Record<string, unknown>
}

function accountPath(account: string, suffix: string): string {
  return `/accounts/${encodeURIComponent(account)}${suffix}`
}

export async function dxtradeSnapshot(creds: DxtradeCredentials, account: string): Promise<DxtradeSnapshot> {
  const accounts = await dxtradeAccounts(creds)
  const info = accounts.find(item => item.account === account)
  if (!info) throw new DxtradeError("This DXtrade account is no longer available on the login", 404)
  const { data } = await dxRequest(creds, accountPath(account, "/metrics"))
  const metrics = rows(data, "metrics")[0] ?? record(data)
  const canTrade = info.status === "FULL_TRADING"
  return {
    balance: finite(metrics.balance),
    equity: finite(metrics.equity),
    profit: finite(metrics.openPl),
    margin: finite(metrics.margin),
    freeMargin: finite(metrics.marginFree),
    currency: info.baseCurrency,
    canTrade,
    openTrades: finite(metrics.openPositionsCount) ?? 0,
    status: {
      status: "ready",
      terminal: { alive: true },
      broker: { connected: true, server: new URL(creds.serverUrl).hostname },
      account: { loggedIn: true, tradeAllowed: canTrade, currency: info.baseCurrency, type: "Live" },
      bridge: { tradeEaReady: true, symbolsSynced: true },
    },
  }
}

// ── Instruments and quotes ─────────────────────────────────────────────────

export interface DxtradeInstrument {
  symbol: string
  lotSize: number
  pipSize: number | undefined
  priceIncrement: number | undefined
  quantityIncrement: number | undefined
  currency: string | undefined
  type: string | undefined
}

function toInstrument(row: Json): DxtradeInstrument | null {
  const symbol = String(row.symbol ?? "").trim()
  if (!symbol) return null
  const lotSize = finite(row.lotSize)
  return {
    symbol,
    lotSize: lotSize && lotSize > 0 ? lotSize : 1,
    pipSize: finite(row.pipSize),
    priceIncrement: finite(row.priceIncrement),
    quantityIncrement: finite(row.quantityIncrement),
    currency: row.currency == null ? undefined : String(row.currency),
    type: row.type == null ? undefined : String(row.type),
  }
}

export function normalizeSymbolKey(symbol: string): string {
  return String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** Match a signal symbol (XAUUSD) to the broker's (XAU/USD, XAUUSD.m). Exact first, then one suffix away. */
export function matchInstrument<T extends { symbol: string }>(list: T[], wanted: string): T | undefined {
  const key = normalizeSymbolKey(wanted)
  if (!key) return undefined
  const exact = list.find(item => item.symbol === wanted) ?? list.find(item => normalizeSymbolKey(item.symbol) === key)
  if (exact) return exact
  const near = list
    .filter(item => {
      const k = normalizeSymbolKey(item.symbol)
      return k.startsWith(key) && k.length - key.length <= 4
    })
    .sort((a, b) => a.symbol.length - b.symbol.length)
  return near[0]
}

export async function dxtradeInstrument(creds: DxtradeCredentials, symbol: string): Promise<DxtradeInstrument | undefined> {
  const direct = await dxRequest(creds, `/instruments/query?symbols=${encodeURIComponent(symbol)}`).catch(() => null)
  const directList = direct ? rows(direct.data, "instruments").map(toInstrument).filter((x): x is DxtradeInstrument => !!x) : []
  const hit = matchInstrument(directList, symbol)
  if (hit) return hit
  const all = await dxRequest(creds, "/instruments/query?limit=5000")
  const list = rows(all.data, "instruments").map(toInstrument).filter((x): x is DxtradeInstrument => !!x)
  return matchInstrument(list, symbol)
}

export async function dxtradeQuote(
  creds: DxtradeCredentials,
  account: string,
  symbol: string,
): Promise<{ symbol: string; bid: number; ask: number }> {
  const instrument = await dxtradeInstrument(creds, symbol)
  if (!instrument) throw new DxtradeError(`Symbol ${symbol} is not available on this DXtrade account`, 404)
  const { data } = await dxRequest(creds, "/marketdata", {
    method: "POST",
    body: { account, symbols: [instrument.symbol], eventTypes: [{ type: "Quote", format: "COMPACT" }] },
  })
  const events = rows(data, "events")
  const quote = events.find(event => String(event.type ?? "Quote") === "Quote" && String(event.symbol ?? instrument.symbol) === instrument.symbol)
    ?? events[0]
  const bid = finite(quote?.bid)
  const ask = finite(quote?.ask)
  if (!bid || !ask) throw new DxtradeError(`DXtrade quote for ${instrument.symbol} is unavailable`, 404)
  return { symbol: instrument.symbol, bid, ask }
}

// ── Positions and trades ───────────────────────────────────────────────────

/** Position codes equal the opening order id (numeric). Hash anything else onto a positive 32-bit int. */
export function ticketFromCode(code: string): number {
  const text = String(code ?? "").trim()
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash + 1
}

export interface DxtradePosition {
  positionCode: string
  symbol: string
  side: "Buy" | "Sell"
  units: number
  lots: number
  openPrice: number
  stopLoss: number | undefined
  takeProfit: number | undefined
  openedAt: string | undefined
}

export async function dxtradePositions(creds: DxtradeCredentials, account: string): Promise<DxtradePosition[]> {
  const { data } = await dxRequest(creds, accountPath(account, "/positions"))
  const list = rows(data, "positions")
  const lotSizes = new Map<string, number>()
  if (list.length) {
    const all = await dxRequest(creds, "/instruments/query?limit=5000").catch(() => null)
    for (const row of all ? rows(all.data, "instruments") : []) {
      const inst = toInstrument(row)
      if (inst) lotSizes.set(inst.symbol, inst.lotSize)
    }
  }
  const out: DxtradePosition[] = []
  for (const row of list) {
    const units = finite(row.quantity) ?? 0
    const positionCode = String(row.positionCode ?? "").trim()
    if (!positionCode || units <= 0) continue
    const symbol = String(row.symbol ?? "").trim()
    const lotSize = lotSizes.get(symbol) ?? 1
    out.push({
      positionCode,
      symbol,
      side: String(row.side ?? "").toUpperCase() === "SELL" ? "Sell" : "Buy",
      units,
      lots: Number((units / lotSize).toPrecision(10)),
      openPrice: finite(row.openPrice) ?? 0,
      stopLoss: finite(row.stopLossPrice),
      takeProfit: finite(row.takeProfitPrice),
      openedAt: row.openTime == null ? undefined : String(row.openTime),
    })
  }
  return out
}

export async function dxtradeOpenedOrders(creds: DxtradeCredentials, account: string): Promise<Record<string, unknown>[]> {
  const positions = await dxtradePositions(creds, account)
  return positions.map(position => ({
    ticket: ticketFromCode(position.positionCode),
    symbol: position.symbol,
    operation: position.side,
    lots: position.lots,
    openPrice: position.openPrice || undefined,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    comment: "",
  }))
}

export async function dxtradeLiveBook(creds: DxtradeCredentials, account: string) {
  const snapshot = await dxtradeSnapshot(creds, account)
  return {
    balance: snapshot.balance,
    equity: snapshot.equity,
    profit: snapshot.profit,
    currency: snapshot.currency,
    openTrades: snapshot.openTrades,
  }
}

export type DxtradeTradeRow = {
  id: string
  broker_id: string
  broker_label: string
  broker_name: string | null
  ticket: number
  symbol: string
  direction: "buy" | "sell" | ""
  type: string
  lot_size: number
  entry_price: number | null
  sl: number | null
  tp: number | null
  close_price: number | null
  profit: number | null
  swap: number | null
  commission: number | null
  comment: string | null
  magic: number | null
  opened_at: string | null
  closed_at: string | null
  state: string | null
  status: "open" | "closed"
}

function isoOrNull(value: unknown): string | null {
  if (value == null || value === "") return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function dxtradeAccountTrades(args: {
  creds: DxtradeCredentials
  account: string
  brokerId: string
  brokerLabel: string
  brokerName: string | null
  historyFrom: string
  historyTo: string
  scope: string
}): Promise<DxtradeTradeRow[]> {
  const { creds, account } = args
  const scope = args.scope.toLowerCase()
  const out: DxtradeTradeRow[] = []

  if (scope !== "closed") {
    for (const position of await dxtradePositions(creds, account)) {
      out.push({
        id: `${args.brokerId}:${position.positionCode}`,
        broker_id: args.brokerId,
        broker_label: args.brokerLabel,
        broker_name: args.brokerName,
        ticket: ticketFromCode(position.positionCode),
        symbol: position.symbol,
        direction: position.side === "Buy" ? "buy" : "sell",
        type: position.side === "Buy" ? "Buy" : "Sell",
        lot_size: position.lots,
        entry_price: position.openPrice || null,
        sl: position.stopLoss ?? null,
        tp: position.takeProfit ?? null,
        close_price: null,
        profit: null,
        swap: null,
        commission: null,
        comment: null,
        magic: null,
        opened_at: isoOrNull(position.openedAt),
        closed_at: null,
        state: "open",
        status: "open",
      })
    }
  }

  if (scope !== "open") {
    const params = new URLSearchParams({ limit: "200", "in-status": "COMPLETED" })
    const from = isoOrNull(args.historyFrom)
    const to = isoOrNull(args.historyTo)
    if (from) params.set("issued-from", from)
    else params.set("period", "week")
    if (to) params.set("issued-to", to)
    try {
      const { data } = await dxRequest(creds, `${accountPath(account, "/orders/history")}?${params.toString()}`)
      const instruments = new Map<string, number>()
      for (const order of rows(data, "orders")) {
        const leg = rows(order.legs)[0] ?? {}
        if (String(leg.positionEffect ?? "").toUpperCase() !== "CLOSE") continue
        const filled = finite(leg.filledQuantity) ?? 0
        if (filled <= 0) continue
        const symbol = String(order.instrument ?? leg.instrument ?? "")
        if (!instruments.has(symbol)) {
          const inst = await dxtradeInstrument(creds, symbol).catch(() => undefined)
          instruments.set(symbol, inst?.lotSize ?? 1)
        }
        const positionCode = String(leg.positionCode ?? order.orderId ?? "")
        // A close order on the opposite side of the position.
        const closeSide = String(order.side ?? "").toUpperCase()
        out.push({
          id: `${args.brokerId}:${positionCode}:${String(order.orderId ?? "")}`,
          broker_id: args.brokerId,
          broker_label: args.brokerLabel,
          broker_name: args.brokerName,
          ticket: ticketFromCode(positionCode),
          symbol,
          direction: closeSide === "SELL" ? "buy" : closeSide === "BUY" ? "sell" : "",
          type: closeSide === "SELL" ? "Buy" : "Sell",
          lot_size: Number((filled / (instruments.get(symbol) ?? 1)).toPrecision(10)),
          entry_price: null,
          sl: null,
          tp: null,
          close_price: finite(leg.averagePrice) || null,
          profit: null,
          swap: null,
          commission: null,
          comment: null,
          magic: null,
          opened_at: null,
          closed_at: isoOrNull(order.transactionTime ?? order.issueTime),
          state: "closed",
          status: "closed",
        })
      }
    } catch {
      // Open positions still show when history is unavailable.
    }
  }
  return out
}
