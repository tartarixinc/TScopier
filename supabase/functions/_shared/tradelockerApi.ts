/**
 * TradeLocker public REST API, used by the tradelocker-broker edge function.
 * Spec: https://public-api.tradelocker.com (v2.11.0).
 *
 * The API hosts are fixed per environment, so a trader never supplies a URL.
 * Auth is a JWT pair from POST /auth/jwt/token {email, password, server}. Every /trade call needs the
 * `accNum` header. List endpoints return rows as arrays; column names come from GET /trade/config.
 */

export type TradelockerEnvironment = "demo" | "live"

export const TRADELOCKER_HOSTS: Record<TradelockerEnvironment, string> = {
  demo: "https://demo.tradelocker.com/backend-api",
  live: "https://live.tradelocker.com/backend-api",
}

export interface TradelockerCredentials {
  environment: TradelockerEnvironment
  server: string
  email: string
  password: string
}

export interface TradelockerAccountRef {
  accountId: string
  accNum: number
}

type Json = Record<string, unknown>

const TIMEOUT_MS = 15_000
const USER_AGENT = "TScopier/1.0 (+https://tscopier.ai)"

export class TradelockerError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "TradelockerError"
    this.status = status
  }
}

export function isTradelockerEnvironment(value: unknown): value is TradelockerEnvironment {
  return value === "demo" || value === "live"
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}
}

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function developerKeyHeaders(): Record<string, string> {
  const key = Deno.env.get("TRADELOCKER_DEVELOPER_API_KEY")?.trim()
  return key ? { "developer-api-key": key, "tl-developer-api-key": key } : {}
}

// ── Transport ──────────────────────────────────────────────────────────────

async function rawFetch(
  environment: TradelockerEnvironment,
  path: string,
  init: { method?: string; token?: string; accNum?: number; body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<unknown> {
  const url = new URL(`${TRADELOCKER_HOSTS[environment]}${path}`)
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    ...developerKeyHeaders(),
  }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  if (init.accNum !== undefined) headers.accNum = String(init.accNum)
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
    throw new TradelockerError(timedOut ? "TradeLocker did not answer in time" : "Could not reach TradeLocker", 0)
  }
  if (response.status >= 300 && response.status < 400) {
    throw new TradelockerError("TradeLocker redirected the request", response.status)
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
  const payload = record(data)
  if (!response.ok || payload.s === "error") {
    const message = String(payload.errmsg ?? payload.message ?? payload.error ?? payload.description ?? "").trim()
    throw new TradelockerError(message || `TradeLocker request failed (${response.status})`, response.ok ? 400 : response.status)
  }
  return data
}

interface Session {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const sessions = new Map<string, Session>()
const loginChains = new Map<string, Promise<Session>>()

function sessionKey(creds: TradelockerCredentials): string {
  return `${creds.environment}|${creds.server.toLowerCase()}|${creds.email.toLowerCase()}`
}

function toSession(data: unknown): Session {
  const payload = record(record(data).d ?? data)
  const accessToken = String(payload.accessToken ?? "").trim()
  const refreshToken = String(payload.refreshToken ?? "").trim()
  if (!accessToken) throw new TradelockerError("TradeLocker did not return a session", 0)
  const expires = Date.parse(String(payload.expireDate ?? ""))
  const expiresAt = Number.isFinite(expires) ? expires - 60_000 : Date.now() + 30 * 60_000
  return { accessToken, refreshToken, expiresAt }
}

async function login(creds: TradelockerCredentials): Promise<Session> {
  const key = sessionKey(creds)
  const inflight = loginChains.get(key)
  if (inflight) return inflight
  const run = (async () => {
    const data = await rawFetch(creds.environment, "/auth/jwt/token", {
      method: "POST",
      body: { email: creds.email, password: creds.password, server: creds.server },
    })
    const session = toSession(data)
    sessions.set(key, session)
    return session
  })().finally(() => loginChains.delete(key))
  loginChains.set(key, run)
  return run
}

async function refresh(creds: TradelockerCredentials, session: Session): Promise<Session> {
  if (!session.refreshToken) return login(creds)
  try {
    const data = await rawFetch(creds.environment, "/auth/jwt/refresh", {
      method: "POST",
      body: { refreshToken: session.refreshToken },
    })
    const next = toSession(data)
    sessions.set(sessionKey(creds), next)
    return next
  } catch {
    return login(creds)
  }
}

// Each route is limited to a few requests per second (GET orders and positions: one per second).
const lastCallAt = new Map<string, number>()

async function pace(key: string, gapMs: number): Promise<void> {
  const wait = (lastCallAt.get(key) ?? 0) + gapMs - Date.now()
  lastCallAt.set(key, Math.max(Date.now(), (lastCallAt.get(key) ?? 0) + gapMs))
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
}

export async function tlRequest(
  creds: TradelockerCredentials,
  path: string,
  init: { method?: string; accNum?: number; body?: unknown; query?: Record<string, string | number | undefined>; gapMs?: number } = {},
): Promise<unknown> {
  const key = sessionKey(creds)
  let session = sessions.get(key)
  if (!session) session = await login(creds)
  else if (session.expiresAt <= Date.now()) session = await refresh(creds, session)
  const send = (token: string) => rawFetch(creds.environment, path, { ...init, token })
  if (init.gapMs) await pace(`${key}|${init.accNum ?? ""}|${path.replace(/\d+/g, "#")}`, init.gapMs)
  try {
    return await send(session.accessToken)
  } catch (error) {
    if (error instanceof TradelockerError && error.status === 401) {
      sessions.delete(key)
      const fresh = await refresh(creds, session)
      return send(fresh.accessToken)
    }
    if (error instanceof TradelockerError && error.status === 429 && (init.method ?? "GET") === "GET") {
      await new Promise(resolve => setTimeout(resolve, 1200))
      return send(session.accessToken)
    }
    throw error
  }
}

export function friendlyTradelockerError(error: unknown): string {
  if (error instanceof TradelockerError) {
    if (error.status === 401 || (error.status === 400 && /credential|password|login|server|invalid/i.test(error.message))) {
      return "TradeLocker rejected this email, password or server name. Use the exact server name shown on the TradeLocker login."
    }
    if (error.status === 403) return "TradeLocker refused the request. Check that this account is allowed to trade through the API."
    if (error.status === 429) return "TradeLocker is rate limiting requests. Try again in a moment."
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

// ── Row helpers ────────────────────────────────────────────────────────────

type Column = { id: string }

const configCache = new Map<string, { at: number; config: Json }>()

export async function tradelockerConfig(creds: TradelockerCredentials, ref: TradelockerAccountRef): Promise<Json> {
  const key = `${sessionKey(creds)}|${ref.accNum}`
  const hit = configCache.get(key)
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.config
  const data = await tlRequest(creds, "/trade/config", { accNum: ref.accNum })
  const config = record(record(data).d)
  configCache.set(key, { at: Date.now(), config })
  return config
}

function columnsOf(config: Json, name: string): string[] {
  const panel = record(config[name])
  return (Array.isArray(panel.columns) ? panel.columns as Column[] : []).map(column => String(record(column).id ?? ""))
}

export function rowsToObjects(columns: string[], list: unknown): Json[] {
  if (!Array.isArray(list)) return []
  return list.map(row => {
    if (Array.isArray(row)) {
      const out: Json = {}
      columns.forEach((column, index) => {
        if (column) out[column] = row[index]
      })
      return out
    }
    return record(row)
  })
}

// ── Accounts ───────────────────────────────────────────────────────────────

export interface TradelockerAccountInfo {
  accountId: string
  accNum: number
  name: string
  currency: string
  status: string
  balance: number | undefined
}

export async function tradelockerAccounts(creds: TradelockerCredentials): Promise<TradelockerAccountInfo[]> {
  const data = await tlRequest(creds, "/auth/jwt/all-accounts")
  const payload = record(data)
  const list = Array.isArray(payload.accounts) ? payload.accounts : record(payload.d).accounts
  const out: TradelockerAccountInfo[] = []
  for (const item of Array.isArray(list) ? list : []) {
    const account = record(item)
    const accountId = String(account.id ?? "").trim()
    const accNum = finite(account.accNum)
    if (!accountId || accNum === undefined) continue
    out.push({
      accountId,
      accNum,
      name: String(account.name ?? "").trim(),
      currency: String(account.currency ?? "").trim() || "USD",
      status: String(account.status ?? "").trim().toUpperCase(),
      balance: finite(account.accountBalance ?? account.balance),
    })
  }
  return out
}

/** Stable per-account id. Hashes environment, server, login and account id so plain values never leak. */
export async function tradelockerFingerprint(
  environment: TradelockerEnvironment,
  server: string,
  email: string,
  accountId: string,
): Promise<string> {
  const text = `${environment}|${server.toLowerCase()}|${email.toLowerCase()}|${accountId}`
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16)
}

// ── Account state ──────────────────────────────────────────────────────────

export interface TradelockerSnapshot {
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

export async function tradelockerSnapshot(
  creds: TradelockerCredentials,
  ref: TradelockerAccountRef,
): Promise<TradelockerSnapshot> {
  const accounts = await tradelockerAccounts(creds)
  const info = accounts.find(item => item.accountId === ref.accountId && item.accNum === ref.accNum)
  if (!info) throw new TradelockerError("This TradeLocker account is no longer available on the login", 404)
  const config = await tradelockerConfig(creds, ref)
  const columns = columnsOf(config, "accountDetailsConfig")
  const data = await tlRequest(creds, `/trade/accounts/${encodeURIComponent(ref.accountId)}/state`, {
    accNum: ref.accNum,
    gapMs: 550,
  })
  const values = record(record(data).d).accountDetailsData
  const state = rowsToObjects(columns, [Array.isArray(values) ? values : []])[0] ?? {}
  const balance = finite(state.balance) ?? info.balance
  const profit = finite(state.openNetPnL) ?? finite(state.openGrossPnL)
  const equity = finite(state.projectedBalance) ?? (balance !== undefined && profit !== undefined ? balance + profit : balance)
  const canTrade = info.status === "ACTIVE"
  return {
    balance,
    equity,
    profit,
    margin: finite(state.initialMarginReq),
    freeMargin: finite(state.availableFunds),
    currency: info.currency,
    canTrade,
    openTrades: finite(state.positionsCount) ?? 0,
    status: {
      status: "ready",
      terminal: { alive: true },
      broker: { connected: true, server: creds.server },
      account: { loggedIn: true, tradeAllowed: canTrade, currency: info.currency, type: creds.environment === "demo" ? "Demo" : "Live" },
      bridge: { tradeEaReady: true, symbolsSynced: true },
    },
  }
}

// ── Instruments and quotes ─────────────────────────────────────────────────

export interface TradelockerInstrument {
  tradableInstrumentId: number
  name: string
  tradeRouteId: number | undefined
  infoRouteId: number | undefined
}

const instrumentCache = new Map<string, { at: number; list: TradelockerInstrument[] }>()

export async function tradelockerInstruments(creds: TradelockerCredentials, ref: TradelockerAccountRef): Promise<TradelockerInstrument[]> {
  const key = `${sessionKey(creds)}|${ref.accNum}`
  const hit = instrumentCache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list
  const data = await tlRequest(creds, `/trade/accounts/${encodeURIComponent(ref.accountId)}/instruments`, {
    accNum: ref.accNum,
    gapMs: 550,
  })
  const list: TradelockerInstrument[] = []
  const instruments = record(record(data).d).instruments
  for (const item of Array.isArray(instruments) ? instruments : []) {
    const row = record(item)
    const id = finite(row.tradableInstrumentId)
    const name = String(row.name ?? "").trim()
    if (id === undefined || !name) continue
    const routes = Array.isArray(row.routes) ? row.routes.map(record) : []
    list.push({
      tradableInstrumentId: id,
      name,
      tradeRouteId: finite(routes.find(route => String(route.type).toUpperCase() === "TRADE")?.id),
      infoRouteId: finite(routes.find(route => String(route.type).toUpperCase() === "INFO")?.id),
    })
  }
  instrumentCache.set(key, { at: Date.now(), list })
  return list
}

export function normalizeSymbolKey(symbol: string): string {
  return String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** Match a signal symbol (XAUUSD) to the broker's (XAU/USD, XAUUSD.x). Exact first, then one suffix away. */
export function matchInstrument<T extends { name: string }>(list: T[], wanted: string): T | undefined {
  const key = normalizeSymbolKey(wanted)
  if (!key) return undefined
  const exact = list.find(item => item.name === wanted) ?? list.find(item => normalizeSymbolKey(item.name) === key)
  if (exact) return exact
  return list
    .filter(item => {
      const k = normalizeSymbolKey(item.name)
      return k.startsWith(key) && k.length - key.length <= 4
    })
    .sort((a, b) => a.name.length - b.name.length)[0]
}

export async function tradelockerQuote(
  creds: TradelockerCredentials,
  ref: TradelockerAccountRef,
  symbol: string,
): Promise<{ symbol: string; bid: number; ask: number }> {
  const instrument = matchInstrument(await tradelockerInstruments(creds, ref), symbol)
  if (!instrument) throw new TradelockerError(`Symbol ${symbol} is not available on this TradeLocker account`, 404)
  if (instrument.infoRouteId === undefined) throw new TradelockerError(`No quote route for ${instrument.name}`, 404)
  const data = await tlRequest(creds, "/trade/quotes", {
    accNum: ref.accNum,
    gapMs: 110,
    query: { routeId: instrument.infoRouteId, tradableInstrumentId: instrument.tradableInstrumentId },
  })
  const quote = record(record(data).d)
  const bid = finite(quote.bp)
  const ask = finite(quote.ap)
  if (!bid || !ask) throw new TradelockerError(`TradeLocker quote for ${instrument.name} is unavailable`, 404)
  return { symbol: instrument.name, bid, ask }
}

// ── Positions and trades ───────────────────────────────────────────────────

export interface TradelockerPosition {
  positionId: string
  symbol: string
  side: "Buy" | "Sell"
  lots: number
  openPrice: number
  stopLoss: number | undefined
  takeProfit: number | undefined
  openedAt: string | undefined
  comment: string
}

function sideOf(value: unknown): "Buy" | "Sell" {
  return String(value ?? "").toLowerCase() === "sell" ? "Sell" : "Buy"
}

function isoFromMs(value: unknown): string | null {
  const n = finite(value)
  if (n !== undefined) {
    const date = new Date(n)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (value == null || value === "") return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function tradelockerPositions(creds: TradelockerCredentials, ref: TradelockerAccountRef): Promise<TradelockerPosition[]> {
  const config = await tradelockerConfig(creds, ref)
  const accountPath = `/trade/accounts/${encodeURIComponent(ref.accountId)}`
  const data = await tlRequest(creds, `${accountPath}/positions`, { accNum: ref.accNum, gapMs: 1100 })
  const positions = rowsToObjects(columnsOf(config, "positionsConfig"), record(record(data).d).positions)
  if (positions.length === 0) return []
  const names = new Map((await tradelockerInstruments(creds, ref)).map(item => [item.tradableInstrumentId, item.name]))
  // Stop loss and take profit are separate orders referenced by id on the position row.
  const protection = new Map<string, Json>()
  try {
    const orderData = await tlRequest(creds, `${accountPath}/orders`, { accNum: ref.accNum, gapMs: 1100 })
    for (const order of rowsToObjects(columnsOf(config, "ordersConfig"), record(record(orderData).d).orders)) {
      protection.set(String(order.id ?? ""), order)
    }
  } catch {
    // Positions still list without protection prices.
  }
  const out: TradelockerPosition[] = []
  for (const row of positions) {
    const positionId = String(row.id ?? "").trim()
    const lots = finite(row.qty) ?? 0
    if (!positionId || lots <= 0) continue
    const sl = protection.get(String(row.stopLossId ?? ""))
    const tp = protection.get(String(row.takeProfitId ?? ""))
    const slPrice = finite(sl?.stopPrice) ?? finite(sl?.price)
    const tpPrice = finite(tp?.price) ?? finite(tp?.stopPrice)
    out.push({
      positionId,
      symbol: names.get(Number(row.tradableInstrumentId)) ?? String(row.tradableInstrumentId ?? ""),
      side: sideOf(row.side),
      lots,
      openPrice: finite(row.avgPrice) ?? 0,
      stopLoss: slPrice && slPrice > 0 ? slPrice : undefined,
      takeProfit: tpPrice && tpPrice > 0 ? tpPrice : undefined,
      openedAt: isoFromMs(row.openDate) ?? undefined,
      comment: String(row.strategyId ?? "").trim(),
    })
  }
  return out
}

export async function tradelockerOpenedOrders(creds: TradelockerCredentials, ref: TradelockerAccountRef): Promise<Record<string, unknown>[]> {
  const positions = await tradelockerPositions(creds, ref)
  return positions.map(position => ({
    ticket: Number(position.positionId),
    symbol: position.symbol,
    operation: position.side,
    lots: position.lots,
    openPrice: position.openPrice || undefined,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    comment: position.comment,
  }))
}

export async function tradelockerLiveBook(creds: TradelockerCredentials, ref: TradelockerAccountRef) {
  const snapshot = await tradelockerSnapshot(creds, ref)
  return {
    balance: snapshot.balance,
    equity: snapshot.equity,
    profit: snapshot.profit,
    currency: snapshot.currency,
    openTrades: snapshot.openTrades,
  }
}

export type TradelockerTradeRow = {
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

function orderTime(order: Json): number {
  const direct = finite(order.createdDate)
  if (direct !== undefined) return direct
  const parsed = Date.parse(String(order.createdDate ?? ""))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Closed trades from order history. A position's opening order is the earliest filled order with its
 * positionId; filled orders on the other side with the same positionId are the closes (manual, stop
 * loss or take profit).
 */
export function closedTradesFromHistory(history: Json[], names: Map<number, string>): Array<{
  positionId: string
  closeId: string
  symbol: string
  positionSide: "Buy" | "Sell"
  lots: number
  openPrice: number | undefined
  closePrice: number | undefined
  openedAt: string | null
  closedAt: string | null
  stopLoss: number | undefined
  takeProfit: number | undefined
  comment: string
}> {
  const filled = history.filter(order => /fill/i.test(String(order.status ?? "")) && (finite(order.filledQty) ?? finite(order.qty) ?? 0) > 0 && String(order.positionId ?? "").trim() !== "")
  const byPosition = new Map<string, Json[]>()
  for (const order of filled) {
    const key = String(order.positionId)
    const list = byPosition.get(key) ?? []
    list.push(order)
    byPosition.set(key, list)
  }
  const out = []
  for (const [positionId, orders] of byPosition) {
    orders.sort((a, b) => orderTime(a) - orderTime(b) || (finite(a.id) ?? 0) - (finite(b.id) ?? 0))
    const opener = orders[0]!
    const side = String(opener.side ?? "").toLowerCase()
    for (const close of orders.slice(1)) {
      if (String(close.side ?? "").toLowerCase() === side) continue
      const slPrice = finite(opener.stopLoss)
      const tpPrice = finite(opener.takeProfit)
      out.push({
        positionId,
        closeId: String(close.id ?? ""),
        symbol: names.get(Number(opener.tradableInstrumentId)) ?? String(opener.tradableInstrumentId ?? ""),
        positionSide: sideOf(opener.side),
        lots: finite(close.filledQty) ?? finite(close.qty) ?? 0,
        openPrice: finite(opener.avgPrice) || undefined,
        closePrice: finite(close.avgPrice) || undefined,
        openedAt: isoFromMs(opener.createdDate),
        closedAt: isoFromMs(close.lastModified) ?? isoFromMs(close.createdDate),
        stopLoss: slPrice && slPrice > 0 ? slPrice : undefined,
        takeProfit: tpPrice && tpPrice > 0 ? tpPrice : undefined,
        comment: String(opener.strategyId ?? "").trim(),
      })
    }
  }
  return out
}

export async function tradelockerAccountTrades(args: {
  creds: TradelockerCredentials
  ref: TradelockerAccountRef
  brokerId: string
  brokerLabel: string
  brokerName: string | null
  historyFrom: string
  historyTo: string
  scope: string
}): Promise<TradelockerTradeRow[]> {
  const { creds, ref } = args
  const scope = args.scope.toLowerCase()
  const out: TradelockerTradeRow[] = []

  if (scope !== "closed") {
    for (const position of await tradelockerPositions(creds, ref)) {
      out.push({
        id: `${args.brokerId}:${position.positionId}`,
        broker_id: args.brokerId,
        broker_label: args.brokerLabel,
        broker_name: args.brokerName,
        ticket: Number(position.positionId),
        symbol: position.symbol,
        direction: position.side === "Buy" ? "buy" : "sell",
        type: position.side,
        lot_size: position.lots,
        entry_price: position.openPrice || null,
        sl: position.stopLoss ?? null,
        tp: position.takeProfit ?? null,
        close_price: null,
        profit: null,
        swap: null,
        commission: null,
        comment: position.comment || null,
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
      const config = await tradelockerConfig(creds, ref)
      const fromMs = Date.parse(args.historyFrom)
      const toMs = Date.parse(args.historyTo)
      const data = await tlRequest(creds, `/trade/accounts/${encodeURIComponent(ref.accountId)}/ordersHistory`, {
        accNum: ref.accNum,
        gapMs: 1100,
        query: {
          from: Number.isFinite(fromMs) ? fromMs : Date.now() - 7 * 24 * 60 * 60 * 1000,
          to: Number.isFinite(toMs) ? toMs : undefined,
        },
      })
      const history = rowsToObjects(columnsOf(config, "ordersHistoryConfig"), record(record(data).d).ordersHistory)
      const names = new Map((await tradelockerInstruments(creds, ref)).map(item => [item.tradableInstrumentId, item.name]))
      for (const trade of closedTradesFromHistory(history, names)) {
        out.push({
          id: `${args.brokerId}:${trade.positionId}:${trade.closeId}`,
          broker_id: args.brokerId,
          broker_label: args.brokerLabel,
          broker_name: args.brokerName,
          ticket: Number(trade.positionId),
          symbol: trade.symbol,
          direction: trade.positionSide === "Buy" ? "buy" : "sell",
          type: trade.positionSide,
          lot_size: trade.lots,
          entry_price: trade.openPrice ?? null,
          sl: trade.stopLoss ?? null,
          tp: trade.takeProfit ?? null,
          close_price: trade.closePrice ?? null,
          profit: null,
          swap: null,
          commission: null,
          comment: trade.comment || null,
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
