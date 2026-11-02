/**
 * Match-Trader Platform API (the per-trader API, not the broker-only Brokers API), used by the
 * matchtrader-broker edge function.
 * Docs: https://app.theneo.io/match-trade/platform-api  (limit 500 requests/minute)
 *
 * Match-Trader is white-label: every broker hosts its own platform URL, so the trader supplies it and
 * `normalizeMatchtraderUrl` + `assertPublicMatchtraderHost` must run before any request (SSRF guard).
 *
 *  - GET  /manager/platform-details            no auth, returns { partnerId (= brokerId), platformUrl, brokerName }
 *  - POST /manager/mtr-login {email,password,brokerId}
 *        -> { token, tradingAccounts[{ uuid, tradingAccountId, tradingApiToken, tradingAccountToken,
 *             offer{ demo, currency, system{ uuid } } }], selectedTradingAccount, tfaConfig }
 *        `token` is a 15 minute session sent as `Cookie: co-auth=<token>`; `tradingApiToken` is sent as
 *        the `Auth-trading-api` header. POST /manager/refresh-token renews it from the login cookies.
 *  - /mtr-api/{systemUuid}/ balance, open-positions, active-orders, quotations?symbols=,
 *        effective-instruments, closed-positions (POST {from,to}), position/open|edit|close|close-partially,
 *        pending-order/create|edit|cancel.
 *  - Writes have no client order id or comment; the worker keeps comments in matchtrader_order_tags.
 *
 * Not verifiable without a real login (see the plan): whether `co-auth` must be the account token for a
 * non-selected account, whether refresh needs the full cookie jar, whether the trading API can live on a
 * different host (`system.tradingApiDomain`), and whether position ids equal the open orderId.
 */

import { isPrivateIp } from "./dxtradeApi.ts"

export class MatchtraderError extends Error {
  status: number
  code: string | undefined
  constructor(message: string, status = 0, code?: string) {
    super(message)
    this.name = "MatchtraderError"
    this.status = status
    this.code = code
  }
}

type Json = Record<string, unknown>

const TIMEOUT_MS = 15_000
const USER_AGENT = "TScopier/1.0 (+https://tscopier.ai)"
const SESSION_TTL_MS = 13 * 60_000

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}
}

export function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

// ── Platform URL validation (SSRF guard) ───────────────────────────────────

const BLOCKED_HOST_SUFFIXES = [
  ".local", ".localhost", ".internal", ".localdomain", ".lan", ".home", ".corp", ".intranet", ".private",
]

export type MatchtraderUrlResult = { ok: true; url: string } | { ok: false; error: string }

/** Accepts `https://host` (a trailing slash is fine) and returns `https://host`. */
export function normalizeMatchtraderUrl(input: string): MatchtraderUrlResult {
  const raw = String(input ?? "").trim()
  if (!raw) return { ok: false, error: "Enter your broker's Match-Trader platform URL" }
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { ok: false, error: "That platform URL is not valid" }
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "The platform URL must start with https://" }
  if (parsed.username || parsed.password) return { ok: false, error: "Remove the username or password from the platform URL" }
  if (parsed.port && parsed.port !== "443") return { ok: false, error: "The platform URL must use the standard HTTPS port" }
  if (parsed.search || parsed.hash) return { ok: false, error: "Remove the query string from the platform URL" }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "")
  if (!host || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[/.test(host)) {
    return { ok: false, error: "Use your broker's host name, not an IP address" }
  }
  if (!host.includes(".") || host === "localhost" || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return { ok: false, error: "That platform URL is not a public broker address" }
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { ok: false, error: "That platform URL is not valid" }
  }
  // Only the host matters; every Platform API route is relative to it.
  return { ok: true, url: `https://${host}` }
}

/** Reject hosts whose DNS answers point at private space. Skipped when the runtime cannot resolve DNS. */
export async function assertPublicMatchtraderHost(serverUrl: string): Promise<void> {
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
    throw new MatchtraderError("That platform URL resolves to a private address and cannot be used", 400)
  }
}

// ── Transport ──────────────────────────────────────────────────────────────

export interface MatchtraderCredentials {
  serverUrl: string
  brokerId: string
  email: string
  password: string
}

export interface MatchtraderAccountRef {
  tradingAccountUuid: string
  systemUuid: string
}

interface RawResult {
  data: unknown
  setCookies: string[]
}

function setCookiesOf(headers: Headers): string[] {
  const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getter === "function") return getter.call(headers)
  const single = headers.get("set-cookie")
  return single ? [single] : []
}

async function rawFetch(
  serverUrl: string,
  path: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    query?: Record<string, string | number | undefined>
  } = {},
): Promise<RawResult> {
  const url = new URL(`${serverUrl}${path}`)
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    ...(init.headers ?? {}),
  }
  let body: string | undefined
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(init.body)
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    throw new MatchtraderError(timedOut ? "The Match-Trader server did not answer in time" : "Could not reach the Match-Trader server", 0)
  }
  if (response.status >= 300 && response.status < 400) {
    throw new MatchtraderError("The Match-Trader server redirected the request", response.status)
  }
  const text = await response.text().catch(() => "")
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!response.ok) {
    const payload = record(data)
    const message = String(payload.errorMessage ?? payload.detail ?? payload.message ?? payload.title ?? payload.error ?? "").trim()
    throw new MatchtraderError(message || `Match-Trader request failed (${response.status})`, response.status)
  }
  return { data, setCookies: setCookiesOf(response.headers) }
}

// ── Login and session ──────────────────────────────────────────────────────

export interface MatchtraderAccountInfo {
  uuid: string
  tradingAccountId: string
  name: string
  currency: string
  demo: boolean
  systemUuid: string
  tradingApiToken: string
  accountToken: string
}

interface LoginResult {
  accounts: MatchtraderAccountInfo[]
  selectedUuid: string
  token: string
  jar: Map<string, string>
  tfaForSignIn: boolean
}

function absorbCookies(jar: Map<string, string>, setCookies: string[]) {
  for (const line of setCookies) {
    const pair = line.split(";")[0] ?? ""
    const index = pair.indexOf("=")
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!name) continue
    if (!value) jar.delete(name)
    else jar.set(name, value)
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
}

function parseAccount(item: unknown): MatchtraderAccountInfo | null {
  const row = record(item)
  const offer = record(row.offer)
  const system = record(offer.system)
  const uuid = String(row.uuid ?? "").trim()
  const systemUuid = String(system.uuid ?? "").trim()
  if (!uuid || !systemUuid) return null
  return {
    uuid,
    tradingAccountId: String(row.tradingAccountId ?? "").trim(),
    name: String(offer.name ?? "").trim(),
    currency: String(offer.currency ?? "").trim() || "USD",
    demo: offer.demo === true || system.demo === true,
    systemUuid,
    tradingApiToken: String(row.tradingApiToken ?? "").trim(),
    accountToken: String(record(row.tradingAccountToken).token ?? "").trim(),
  }
}

async function rawLogin(creds: MatchtraderCredentials): Promise<LoginResult> {
  const { data, setCookies } = await rawFetch(creds.serverUrl, "/manager/mtr-login", {
    method: "POST",
    body: { email: creds.email, password: creds.password, brokerId: creds.brokerId },
  })
  const payload = record(data)
  const list = Array.isArray(payload.tradingAccounts) ? payload.tradingAccounts : Array.isArray(payload.accounts) ? payload.accounts : []
  const accounts = list.map(parseAccount).filter((item): item is MatchtraderAccountInfo => item !== null)
  const jar = new Map<string, string>()
  absorbCookies(jar, setCookies)
  const token = String(payload.token ?? "").trim()
  if (token && !jar.has("co-auth")) jar.set("co-auth", token)
  const selected = record(payload.selectedTradingAccount)
  return {
    accounts,
    selectedUuid: String(selected.uuid ?? "").trim(),
    token,
    jar,
    tfaForSignIn: record(payload.tfaConfig).isEnabledForSignIn === true,
  }
}

interface Session {
  jar: Map<string, string>
  tradingApiToken: string
  systemUuid: string
  expiresAt: number
  usedAltToken: boolean
  altToken: string
}

const sessions = new Map<string, Session>()
const loginChains = new Map<string, Promise<Session>>()

export function matchtraderSessionKey(creds: MatchtraderCredentials, accountUuid: string): string {
  return `${creds.serverUrl}|${creds.brokerId}|${creds.email.toLowerCase()}|${accountUuid}`
}

function sessionFrom(login: LoginResult, account: MatchtraderAccountInfo): Session {
  const jar = new Map(login.jar)
  // The login token covers the selected account. A different account may need its own account token as
  // the co-auth cookie, so the other candidate is kept for one retry after a 401.
  const base = jar.get("co-auth") ?? ""
  const own = account.accountToken
  let altToken = ""
  if (own && own !== base) {
    if (login.selectedUuid && account.uuid !== login.selectedUuid) {
      jar.set("co-auth", own)
      altToken = base
    } else {
      altToken = own
    }
  }
  return {
    jar,
    tradingApiToken: account.tradingApiToken,
    systemUuid: account.systemUuid,
    expiresAt: Date.now() + SESSION_TTL_MS,
    usedAltToken: false,
    altToken,
  }
}

async function loginSession(creds: MatchtraderCredentials, accountUuid: string): Promise<Session> {
  const key = matchtraderSessionKey(creds, accountUuid)
  const inflight = loginChains.get(key)
  if (inflight) return inflight
  const run = (async () => {
    const login = await rawLogin(creds)
    if (login.tfaForSignIn) {
      throw new MatchtraderError("Two-factor sign-in is enabled for this Match-Trader login", 403, "TFA")
    }
    const account = login.accounts.find(item => item.uuid === accountUuid)
    if (!account) throw new MatchtraderError("This Match-Trader account is no longer available on the login", 404)
    const session = sessionFrom(login, account)
    sessions.set(key, session)
    return session
  })().finally(() => loginChains.delete(key))
  loginChains.set(key, run)
  return run
}

async function refreshSession(creds: MatchtraderCredentials, accountUuid: string, session: Session): Promise<Session> {
  try {
    const { data, setCookies } = await rawFetch(creds.serverUrl, "/manager/refresh-token", {
      method: "POST",
      headers: { Cookie: cookieHeader(session.jar) },
    })
    const jar = new Map(session.jar)
    absorbCookies(jar, setCookies)
    const token = String(record(data).token ?? "").trim()
    if (token) jar.set("co-auth", token)
    if (setCookies.length === 0 && !token) return loginSession(creds, accountUuid)
    const next: Session = { ...session, jar, expiresAt: Date.now() + SESSION_TTL_MS }
    sessions.set(matchtraderSessionKey(creds, accountUuid), next)
    return next
  } catch {
    return loginSession(creds, accountUuid)
  }
}

export async function mtRequest(
  creds: MatchtraderCredentials,
  ref: MatchtraderAccountRef,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<unknown> {
  const key = matchtraderSessionKey(creds, ref.tradingAccountUuid)
  let session = sessions.get(key)
  if (!session) session = await loginSession(creds, ref.tradingAccountUuid)
  else if (session.expiresAt <= Date.now()) session = await refreshSession(creds, ref.tradingAccountUuid, session)
  const route = `/mtr-api/${encodeURIComponent(session.systemUuid || ref.systemUuid)}${path}`
  const send = (active: Session) => rawFetch(creds.serverUrl, route, {
    ...init,
    headers: { "Auth-trading-api": active.tradingApiToken, Cookie: cookieHeader(active.jar) },
  }).then(result => result.data)
  try {
    return await send(session)
  } catch (error) {
    if (error instanceof MatchtraderError && error.status === 401) {
      sessions.delete(key)
      const fresh = await loginSession(creds, ref.tradingAccountUuid)
      try {
        return await send(fresh)
      } catch (retry) {
        if (retry instanceof MatchtraderError && retry.status === 401 && fresh.altToken && !fresh.usedAltToken) {
          const alt: Session = { ...fresh, jar: new Map(fresh.jar), usedAltToken: true }
          alt.jar.set("co-auth", fresh.altToken)
          sessions.set(key, alt)
          return send(alt)
        }
        throw retry
      }
    }
    if (error instanceof MatchtraderError && error.status === 429 && (init.method ?? "GET") === "GET") {
      await new Promise(resolve => setTimeout(resolve, 1200))
      return send(session)
    }
    throw error
  }
}

export function friendlyMatchtraderError(error: unknown): string {
  if (error instanceof MatchtraderError) {
    if (error.code === "TFA") {
      return "Two-factor sign-in is switched on for this Match-Trader login, so it cannot be linked. Turn it off on your broker's platform and try again."
    }
    if (error.status === 401 || error.status === 400 || error.status === 403) {
      if (/credential|password|login|email|invalid|unauthor|forbidden|broker/i.test(error.message) || error.status === 401) {
        return "Match-Trader rejected this email, password or broker. Check the platform URL and your login."
      }
    }
    if (error.status === 404) return error.message
    if (error.status === 429) return "Match-Trader is rate limiting requests. Try again in a moment."
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

// ── Discovery and accounts ─────────────────────────────────────────────────

export interface MatchtraderPlatformDetails {
  brokerId: string
  brokerName: string
}

/** Public endpoint: the broker id (partnerId) and display name of this platform. */
export async function matchtraderPlatformDetails(serverUrl: string): Promise<MatchtraderPlatformDetails> {
  const { data } = await rawFetch(serverUrl, "/manager/platform-details")
  const payload = record(data)
  const brokerId = String(payload.partnerId ?? payload.brokerId ?? "").trim()
  if (!brokerId) throw new MatchtraderError("This URL did not answer like a Match-Trader platform", 400)
  return { brokerId, brokerName: String(payload.brokerName ?? "").trim() }
}

/** Log in and list trading accounts. Used by the link flow; rejects 2FA sign-in. */
export async function matchtraderAccounts(creds: MatchtraderCredentials): Promise<MatchtraderAccountInfo[]> {
  const login = await rawLogin(creds)
  if (login.tfaForSignIn) {
    throw new MatchtraderError("Two-factor sign-in is enabled for this Match-Trader login", 403, "TFA")
  }
  return login.accounts
}

/** Stable per-account id. Hashes host, broker, login and trading account so plain values never leak. */
export async function matchtraderFingerprint(
  serverUrl: string,
  brokerId: string,
  email: string,
  accountUuid: string,
): Promise<string> {
  const host = new URL(serverUrl).hostname.toLowerCase()
  const text = `${host}|${brokerId}|${email.toLowerCase()}|${accountUuid}`
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16)
}

/** Match-Trader ids look like `W6910422326264457`; the numeric part is the ticket used elsewhere. */
export function ticketFromId(id: unknown): number {
  const digits = String(id ?? "").replace(/\D/g, "")
  const n = Number(digits)
  return Number.isSafeInteger(n) ? n : 0
}

function isoFromMs(value: unknown): string | null {
  const n = finite(value)
  if (n !== undefined) {
    const date = new Date(n)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  return null
}

/** Server timestamps carry no zone ("2024-07-13T04:30:35"); they are read as UTC. */
function isoFromText(value: unknown): string | null {
  const text = String(value ?? "").trim()
  if (!text) return null
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`
  const date = new Date(withZone)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// ── Account state ──────────────────────────────────────────────────────────

export interface MatchtraderSnapshot {
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

export async function matchtraderSnapshot(
  creds: MatchtraderCredentials,
  ref: MatchtraderAccountRef,
  hints: { demo?: boolean; brokerName?: string } = {},
): Promise<MatchtraderSnapshot> {
  const data = record(await mtRequest(creds, ref, "/balance"))
  const balance = finite(data.balance)
  const equity = finite(data.equity) ?? balance
  const currency = String(data.currency ?? "").trim() || "USD"
  let openTrades = 0
  try {
    openTrades = (await matchtraderPositions(creds, ref)).length
  } catch {
    // The balance alone proves the account is reachable.
  }
  return {
    balance,
    equity,
    profit: finite(data.profit),
    margin: finite(data.margin),
    freeMargin: finite(data.freeMargin),
    currency,
    canTrade: true,
    openTrades,
    status: {
      status: "ready",
      terminal: { alive: true },
      broker: { connected: true, server: hints.brokerName ?? new URL(creds.serverUrl).hostname },
      account: { loggedIn: true, tradeAllowed: true, currency, type: hints.demo === false ? "Live" : hints.demo === true ? "Demo" : undefined },
      bridge: { tradeEaReady: true, symbolsSynced: true },
    },
  }
}

// ── Instruments and quotes ─────────────────────────────────────────────────

export interface MatchtraderInstrument {
  symbol: string
  alias: string
  volumeMin: number | undefined
  volumeMax: number | undefined
  volumeStep: number | undefined
  volumePrecision: number | undefined
  contractSize: number | undefined
}

const instrumentCache = new Map<string, { at: number; list: MatchtraderInstrument[] }>()

export async function matchtraderInstruments(creds: MatchtraderCredentials, ref: MatchtraderAccountRef): Promise<MatchtraderInstrument[]> {
  const key = matchtraderSessionKey(creds, ref.tradingAccountUuid)
  const hit = instrumentCache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list
  const data = await mtRequest(creds, ref, "/effective-instruments")
  const source = Array.isArray(data) ? data : Array.isArray(record(data).instruments) ? record(data).instruments as unknown[] : []
  const list: MatchtraderInstrument[] = []
  for (const item of source) {
    const row = record(item)
    const symbol = String(row.symbol ?? "").trim()
    if (!symbol) continue
    list.push({
      symbol,
      alias: String(row.alias ?? "").trim(),
      volumeMin: finite(row.volumeMin),
      volumeMax: finite(row.volumeMax),
      volumeStep: finite(row.volumeStep),
      volumePrecision: finite(row.volumePrecision),
      contractSize: finite(row.contractSize),
    })
  }
  instrumentCache.set(key, { at: Date.now(), list })
  return list
}

export function normalizeSymbolKey(symbol: string): string {
  return String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** Match a signal symbol (XAUUSD) to the broker's (XAU/USD, XAUUSD.x). Exact first, then one suffix away. */
export function matchInstrument(list: MatchtraderInstrument[], wanted: string): MatchtraderInstrument | undefined {
  const key = normalizeSymbolKey(wanted)
  if (!key) return undefined
  const names = (item: MatchtraderInstrument) => [item.symbol, item.alias].filter(Boolean)
  const exact = list.find(item => names(item).includes(wanted)) ??
    list.find(item => names(item).some(name => normalizeSymbolKey(name) === key))
  if (exact) return exact
  return list
    .filter(item => names(item).some(name => {
      const k = normalizeSymbolKey(name)
      return k.startsWith(key) && k.length - key.length <= 4
    }))
    .sort((a, b) => a.symbol.length - b.symbol.length)[0]
}

export async function matchtraderQuote(
  creds: MatchtraderCredentials,
  ref: MatchtraderAccountRef,
  symbol: string,
): Promise<{ symbol: string; bid: number; ask: number }> {
  const instrument = matchInstrument(await matchtraderInstruments(creds, ref), symbol)
  if (!instrument) throw new MatchtraderError(`Symbol ${symbol} is not available on this Match-Trader account`, 404)
  const data = await mtRequest(creds, ref, "/quotations", { query: { symbols: instrument.symbol } })
  const rows = Array.isArray(data) ? data : Object.values(record(data))
  for (const item of rows) {
    const row = record(item)
    const bid = finite(row.bid)
    const ask = finite(row.ask)
    if (bid && ask) return { symbol: instrument.symbol, bid, ask }
  }
  throw new MatchtraderError(`Match-Trader quote for ${instrument.symbol} is unavailable`, 404)
}

// ── Positions and trades ───────────────────────────────────────────────────

export interface MatchtraderPosition {
  positionId: string
  symbol: string
  side: "Buy" | "Sell"
  lots: number
  openPrice: number
  stopLoss: number | undefined
  takeProfit: number | undefined
  openedAt: string | undefined
  profit: number | undefined
}

function sideOf(value: unknown): "Buy" | "Sell" {
  return String(value ?? "").toLowerCase() === "sell" ? "Sell" : "Buy"
}

export async function matchtraderPositions(creds: MatchtraderCredentials, ref: MatchtraderAccountRef): Promise<MatchtraderPosition[]> {
  const data = record(await mtRequest(creds, ref, "/open-positions"))
  const out: MatchtraderPosition[] = []
  for (const item of Array.isArray(data.positions) ? data.positions : []) {
    const row = record(item)
    const positionId = String(row.id ?? "").trim()
    const lots = finite(row.volume) ?? 0
    if (!positionId || lots <= 0) continue
    const sl = finite(row.stopLoss)
    const tp = finite(row.takeProfit)
    out.push({
      positionId,
      symbol: String(row.symbol ?? row.alias ?? "").trim(),
      side: sideOf(row.side),
      lots,
      openPrice: finite(row.openPrice) ?? 0,
      stopLoss: sl && sl > 0 ? sl : undefined,
      takeProfit: tp && tp > 0 ? tp : undefined,
      openedAt: isoFromMs(row.openTimeMillis) ?? isoFromText(row.openTime) ?? undefined,
      profit: finite(row.profit),
    })
  }
  return out
}

/** Comment for a position id: exact id first, then the numeric part (ids differ only by their letter prefix). */
export function tagFor(tags: Map<string, string> | undefined, id: string): string {
  if (!tags || tags.size === 0) return ""
  const exact = tags.get(id)
  if (exact !== undefined) return exact
  const digits = String(id).replace(/\D/g, "")
  for (const [key, value] of tags) if (key.replace(/\D/g, "") === digits) return value
  return ""
}

export async function matchtraderOpenedOrders(
  creds: MatchtraderCredentials,
  ref: MatchtraderAccountRef,
  tags?: Map<string, string>,
): Promise<Record<string, unknown>[]> {
  const positions = await matchtraderPositions(creds, ref)
  return positions.map(position => ({
    ticket: ticketFromId(position.positionId),
    symbol: position.symbol,
    operation: position.side,
    lots: position.lots,
    openPrice: position.openPrice || undefined,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    comment: tagFor(tags, position.positionId),
  }))
}

export async function matchtraderLiveBook(creds: MatchtraderCredentials, ref: MatchtraderAccountRef) {
  const snapshot = await matchtraderSnapshot(creds, ref)
  return {
    balance: snapshot.balance,
    equity: snapshot.equity,
    profit: snapshot.profit,
    currency: snapshot.currency,
    openTrades: snapshot.openTrades,
  }
}

export type MatchtraderTradeRow = {
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

export interface MatchtraderClosedRow {
  positionId: string
  uid: string
  symbol: string
  side: "Buy" | "Sell"
  lots: number
  openPrice: number | undefined
  closePrice: number | undefined
  openedAt: string | null
  closedAt: string | null
  stopLoss: number | undefined
  takeProfit: number | undefined
  profit: number | undefined
  netProfit: number | undefined
  swap: number | undefined
  commission: number | undefined
  closeReason: string
}

/** POST closed-positions. Partial closes are separate rows that share the position id. */
export async function matchtraderClosedPositions(
  creds: MatchtraderCredentials,
  ref: MatchtraderAccountRef,
  fromIso: string,
  toIso: string,
): Promise<MatchtraderClosedRow[]> {
  const data = record(await mtRequest(creds, ref, "/closed-positions", { method: "POST", body: { from: fromIso, to: toIso } }))
  const out: MatchtraderClosedRow[] = []
  for (const item of Array.isArray(data.operations) ? data.operations : []) {
    const row = record(item)
    const positionId = String(row.id ?? "").trim()
    if (!positionId) continue
    const sl = finite(row.stopLoss)
    const tp = finite(row.takeProfit)
    out.push({
      positionId,
      uid: String(row.uid ?? `${positionId}:${String(row.time ?? "")}`),
      symbol: String(row.symbol ?? row.alias ?? "").trim(),
      side: sideOf(row.side),
      lots: finite(row.volume) ?? 0,
      openPrice: finite(row.openPrice) || undefined,
      closePrice: finite(row.closePrice) || undefined,
      openedAt: isoFromText(row.openTime),
      closedAt: isoFromText(row.time),
      stopLoss: sl && sl > 0 ? sl : undefined,
      takeProfit: tp && tp > 0 ? tp : undefined,
      profit: finite(row.profit),
      netProfit: finite(row.netProfit),
      swap: finite(row.swap),
      commission: finite(row.commission),
      closeReason: String(row.closeReason ?? "").trim(),
    })
  }
  return out
}

export async function matchtraderAccountTrades(args: {
  creds: MatchtraderCredentials
  ref: MatchtraderAccountRef
  brokerId: string
  brokerLabel: string
  brokerName: string | null
  historyFrom: string
  historyTo: string
  scope: string
  tags?: Map<string, string>
}): Promise<MatchtraderTradeRow[]> {
  const { creds, ref } = args
  const scope = args.scope.toLowerCase()
  const out: MatchtraderTradeRow[] = []

  if (scope !== "closed") {
    for (const position of await matchtraderPositions(creds, ref)) {
      out.push({
        id: `${args.brokerId}:${position.positionId}`,
        broker_id: args.brokerId,
        broker_label: args.brokerLabel,
        broker_name: args.brokerName,
        ticket: ticketFromId(position.positionId),
        symbol: position.symbol,
        direction: position.side === "Buy" ? "buy" : "sell",
        type: position.side,
        lot_size: position.lots,
        entry_price: position.openPrice || null,
        sl: position.stopLoss ?? null,
        tp: position.takeProfit ?? null,
        close_price: null,
        profit: position.profit ?? null,
        swap: null,
        commission: null,
        comment: tagFor(args.tags, position.positionId) || null,
        magic: null,
        opened_at: position.openedAt ?? null,
        closed_at: null,
        state: "open",
        status: "open",
      })
    }
  }

  if (scope !== "open") {
    try {
      const fromMs = Date.parse(args.historyFrom)
      const toMs = Date.parse(args.historyTo)
      const from = new Date(Number.isFinite(fromMs) ? fromMs : Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const to = new Date(Number.isFinite(toMs) ? toMs : Date.now()).toISOString()
      for (const trade of await matchtraderClosedPositions(creds, ref, from, to)) {
        out.push({
          id: `${args.brokerId}:${trade.uid}`,
          broker_id: args.brokerId,
          broker_label: args.brokerLabel,
          broker_name: args.brokerName,
          ticket: ticketFromId(trade.positionId),
          symbol: trade.symbol,
          direction: trade.side === "Buy" ? "buy" : "sell",
          type: trade.side,
          lot_size: trade.lots,
          entry_price: trade.openPrice ?? null,
          sl: trade.stopLoss ?? null,
          tp: trade.takeProfit ?? null,
          close_price: trade.closePrice ?? null,
          profit: trade.profit ?? null,
          swap: trade.swap ?? null,
          commission: trade.commission ?? null,
          comment: tagFor(args.tags, trade.positionId) || null,
          magic: null,
          opened_at: trade.openedAt,
          closed_at: trade.closedAt,
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
