import { Agent, request } from 'undici'
import { isMtBridgeGlitchMessage } from './brokerConnectError'
import { ingestMtHistoryRows, type MtHistoryProfile } from './mtTradeFields'

/**
 * MetatraderAPI (metatraderapi.dev) Node client tuned for low order-send latency.
 *
 * - Singleton undici Agent keeps TLS-warm pools per platform host (mt4/mt5.mt4api.dev).
 * - Basic Auth; platform-specific paths (OrderSendSafe vs OrderSend). See docs/mt4api-endpoint-map.md.
 */

const DEFAULT_MT5_BASE = 'https://mt5.mt4api.dev'
const DEFAULT_MT4_BASE = 'https://mt4.mt4api.dev'

const MT4API_HTTP_CONNECTIONS = Math.max(
  8,
  Math.min(512, Number(process.env.MT4API_HTTP_CONNECTIONS ?? 128)),
)

const KEEP_ALIVE_AGENT = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connections: MT4API_HTTP_CONNECTIONS,
  pipelining: 1,
})

export type MtPlatform = 'MT4' | 'MT5'

export type MtOperation =
  | 'Buy'
  | 'Sell'
  | 'BuyLimit'
  | 'SellLimit'
  | 'BuyStop'
  | 'SellStop'
  | 'BuyStopLimit'
  | 'SellStopLimit'

/** Pending / stop entry types require a positive limit/stop price on OrderSend. */
export function orderOperationRequiresPrice(operation: string): boolean {
  return (
    operation === 'BuyLimit'
    || operation === 'SellLimit'
    || operation === 'BuyStop'
    || operation === 'SellStop'
    || operation === 'BuyStopLimit'
    || operation === 'SellStopLimit'
  )
}

export interface OrderSendArgs {
  symbol: string
  operation: MtOperation
  volume: number
  price?: number | null
  slippage?: number
  stoploss?: number | null
  takeprofit?: number | null
  comment?: string
  expertID?: number
  expiration?: string
  expirationType?: 'GTC' | 'Today' | 'Specified' | 'SpecifiedDay'
}

export interface OrderModifyArgs {
  ticket: number
  stoploss?: number | null
  takeprofit?: number | null
  price?: number | null
  expiration?: string
  expirationType?: 'GTC' | 'Today' | 'Specified' | 'SpecifiedDay'
}

export interface OrderCloseArgs {
  ticket: number
  lots?: number
  price?: number
  slippage?: number
}

export interface OrderResult {
  ticket: number
  openPrice?: number
  stopLoss?: number
  takeProfit?: number
  lots?: number
  symbol?: string
  orderType?: string
  state?: string
  closePrice?: number
  profit?: number
  swap?: number
  commission?: number
  fee?: number
  comment?: string
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function nestedTicket(o: Record<string, unknown>, key: string): unknown {
  const nest = o[key]
  if (nest == null || typeof nest !== 'object') return undefined
  const n = nest as Record<string, unknown>
  return n.ticket ?? n.Ticket ?? n.order ?? n.Order
}

/**
 * MetatraderAPI JSON often follows protobuf names: PascalCase on the `Order`
 * object, and `OrderSendReply` wraps the order as `{ result: { ... }, error }`.
 * Normalize to our camelCase `OrderResult` so callers always see `ticket`.
 */
export function normalizeOrderResponse(body: unknown): OrderResult {
  if (body == null || typeof body !== 'object') {
    return { ticket: NaN }
  }
  const root = body as Record<string, unknown>

  // OrderSendReply / OrderModifyReply / OrderCloseReply: { result: Order, error?: ... }
  let o: Record<string, unknown> = root
  if ('result' in root && root.result != null && typeof root.result === 'object') {
    o = root.result as Record<string, unknown>
  }

  const ticketRaw =
    o.ticket ??
    o.Ticket ??
    o.orderId ??
    o.OrderId ??
    nestedTicket(o, 'deal') ??
    nestedTicket(o, 'Deal') ??
    nestedTicket(o, 'DealInternalIn') ??
    nestedTicket(o, 'ex')
  const ticket = typeof ticketRaw === 'number' ? ticketRaw : Number(ticketRaw)

  return {
    ticket: Number.isFinite(ticket) ? ticket : NaN,
    openPrice: num(o.openPrice ?? o.OpenPrice),
    stopLoss: num(o.stopLoss ?? o.StopLoss),
    takeProfit: num(o.takeProfit ?? o.TakeProfit),
    lots: num(o.lots ?? o.Lots ?? o.volume ?? o.Volume),
    symbol: typeof o.symbol === 'string' ? o.symbol : typeof o.Symbol === 'string' ? o.Symbol : undefined,
    orderType: typeof o.orderType === 'string' ? o.orderType : typeof o.OrderType === 'string' ? String(o.OrderType) : undefined,
    state: typeof o.state === 'string' ? o.state : typeof o.State === 'string' ? String(o.State) : undefined,
    closePrice: num(o.closePrice ?? o.ClosePrice),
    profit: num(o.profit ?? o.Profit),
    swap: num(o.swap ?? o.Swap),
    commission: num(o.commission ?? o.Commission),
    fee: num(o.fee ?? o.Fee),
    comment: typeof o.comment === 'string' ? o.comment : typeof o.Comment === 'string' ? o.Comment : undefined,
  }
}

function assertNoApiError(body: unknown): void {
  if (body == null || typeof body !== 'object') return
  const root = body as Record<string, unknown>

  // Shape A: { error: { message, code } }
  const err = root.error
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const m = String(e.message ?? e.Message ?? '').trim()
    if (m && m !== 'null' && m !== 'undefined') {
      throw new MetatraderApiError(m, 200, e.code != null ? String(e.code) : undefined)
    }
  }

  // Shape B: top-level { message, code, stackTrace } (no `error` wrapper, no `result`).
  // This is what mt5rest returns for things like "Symbol not found".
  if (!('result' in root) && !('ticket' in root) && !('Ticket' in root)) {
    const m = root.message ?? root.Message
    const code = root.code ?? root.Code
    if (typeof m === 'string' && m.trim()) {
      // Treat code 'OK' / 'DONE' with a message as still-an-error when there's no order payload.
      throw new MetatraderApiError(m.trim(), 200, code != null ? String(code) : undefined)
    }
  }
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
}

export interface SymbolParams {
  symbolName?: string
  symbol?: {
    digits?: number
    point?: number
    contractSize?: number
    stopsLevel?: number
    freezeLevel?: number
  }
  groupParams?: {
    minLot?: number
    maxLot?: number
    lotStep?: number
  }
  /**
   * Raw passthrough so callers can recover fields that the strict typings
   * don't enumerate (different MT5 bridge builds use different casings —
   * `StopsLevel` vs `stopsLevel`, `volume_min` vs `minLot`, etc.). Use
   * `readSymbolParam` to read with multi-casing fallbacks.
   */
  [key: string]: unknown
}

/**
 * Normalised view of `/SymbolParams` that hides the bridge-version-specific
 * field casings. Returns `undefined` for fields that genuinely aren't present
 * so callers can apply their own defaults.
 */
export interface NormalizedSymbolParams {
  digits?: number
  point?: number
  contractSize?: number
  stopsLevel?: number
  freezeLevel?: number
  minLot?: number
  maxLot?: number
  lotStep?: number
}

/**
 * Read a numeric field tolerating camelCase, PascalCase, and snake_case keys.
 * MT5 bridges (and the underlying MqlSymbolInfo struct) ship every casing in
 * the wild, so we accept any of them rather than guess.
 */
function readNum(obj: unknown, ...keys: string[]): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (v == null) continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Normalise a /SymbolParams response across the casing variants we've seen. */
export function normalizeSymbolParams(p: SymbolParams | null | undefined): NormalizedSymbolParams {
  if (!p || typeof p !== 'object') return {}
  const sym = (p as Record<string, unknown>).symbol ?? (p as Record<string, unknown>).Symbol ?? p
  const grp = (p as Record<string, unknown>).groupParams
    ?? (p as Record<string, unknown>).GroupParams
    ?? (p as Record<string, unknown>).group
    ?? (p as Record<string, unknown>).Group
    ?? p
  return {
    digits: readNum(sym, 'digits', 'Digits', 'DIGITS'),
    point: readNum(sym, 'point', 'Point', 'POINT'),
    contractSize: readNum(sym, 'contractSize', 'ContractSize', 'contract_size', 'TradeContractSize'),
    stopsLevel: readNum(sym, 'stopsLevel', 'StopsLevel', 'stops_level', 'TradeStopsLevel', 'trade_stops_level'),
    freezeLevel: readNum(sym, 'freezeLevel', 'FreezeLevel', 'freeze_level', 'TradeFreezeLevel', 'trade_freeze_level'),
    minLot: readNum(grp, 'minLot', 'MinLot', 'min_lot', 'volume_min', 'VolumeMin', 'volumeMin'),
    maxLot: readNum(grp, 'maxLot', 'MaxLot', 'max_lot', 'volume_max', 'VolumeMax', 'volumeMax'),
    lotStep: readNum(grp, 'lotStep', 'LotStep', 'lot_step', 'volume_step', 'VolumeStep', 'volumeStep'),
  }
}

/** Live quote (bid/ask) snapshot for a symbol. */
export interface QuoteResult {
  symbol: string
  bid: number
  ask: number
  time?: string
}

export class MetatraderApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'MetatraderApiError'
    this.status = status
    this.code = code
  }
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    out.set(k, String(v))
  }
  return out.toString()
}

/** MetatraderAPI date query format (yyyy-MM-ddTHH:mm:ss). */
export function formatMtApiDateTime(d: Date): string {
  return d.toISOString().slice(0, 19)
}

export function unwrapOrderList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (Array.isArray(r.result)) return r.result
    if (Array.isArray(r.Result)) return r.Result
    if (Array.isArray(r.orders)) return r.orders
    if (Array.isArray(r.Orders)) return r.Orders
    const nested = r.result ?? r.Result
    if (nested && typeof nested === 'object') {
      const pr = nested as Record<string, unknown>
      const orders = pr.Orders ?? pr.orders
      if (Array.isArray(orders)) return orders
    }
  }
  return []
}

function trimEnv(v: string | undefined): string {
  return (v ?? '').trim()
}

/** Strip copy-paste junk from env URLs, e.g. `(https://mt4.mt4api.dev/)` → `https://mt4.mt4api.dev` */
function normalizeBaseUrl(raw: string, fallback: string): string {
  let u = trimEnv(raw)
  if (!u) return fallback.replace(/\/+$/, '')
  u = u.replace(/^[<\[(]+/, '').replace(/[>\])]+$/, '')
  u = u.replace(/\/+$/, '')
  try {
    const parsed = new URL(u.includes('://') ? u : `https://${u}`)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    console.warn(`[metatraderapi] invalid base URL "${raw.slice(0, 80)}", using default`)
    return fallback.replace(/\/+$/, '')
  }
}

/** RFC 7617: Authorization: Basic base64(username + ":" + password) */
function basicAuthHeaderFromUserPass(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
}

function normalizeAuthorizationHeader(value: string): string {
  const v = value.trim()
  if (!v) return ''
  return /^Basic\s+/i.test(v) ? v : `Basic ${v}`
}

/**
 * Resolve MT API Basic Auth from env. Prefer plain USER + PASSWORD (we base64-encode).
 * Optional: MT4API_BASIC_TOKEN = already-encoded base64(user:pass), or
 * MT4API_AUTHORIZATION = full header value ("Basic …").
 */
export function resolveBasicAuthHeader(env: NodeJS.ProcessEnv): string {
  const authorization = trimEnv(env.MT4API_AUTHORIZATION)
  if (authorization) return normalizeAuthorizationHeader(authorization)

  const token = trimEnv(env.MT4API_BASIC_TOKEN)
  if (token) return normalizeAuthorizationHeader(token)

  const user = trimEnv(env.MT4API_BASIC_USER ?? env.METATRADERAPI_BASIC_USER)
  const password = trimEnv(env.MT4API_BASIC_PASSWORD ?? env.METATRADERAPI_BASIC_PASSWORD)
  if (!user || !password) {
    throw new Error('MT4API_BASIC_USER and MT4API_BASIC_PASSWORD are required (plain text, not base64)')
  }
  return basicAuthHeaderFromUserPass(user, password)
}

export function isMtApiAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    resolveBasicAuthHeader(env)
    return true
  } catch {
    return false
  }
}

/** Interpret /CheckConnect payloads across MT4/MT5 bridge versions. */
export function isCheckConnectOk(body: unknown): boolean {
  if (body === true) return true
  if (body === false) return false
  if (typeof body === 'number') return body > 0
  if (typeof body === 'string') {
    const s = body.trim().toLowerCase()
    if (!s) return false
    if (s === 'true' || s === 'ok' || s === 'connected' || s === 'yes' || s === '1') return true
    if (
      s === 'false'
      || s === '0'
      || s.includes('not connected')
      || s.includes('disconnected')
      || s.includes('notconnected')
    ) {
      return false
    }
    return true
  }
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>
    const nested = r.result ?? r.Result
    if (nested !== undefined && nested !== r) return isCheckConnectOk(nested)
    const flag = r.connected ?? r.Connected ?? r.isConnected ?? r.IsConnected
    if (typeof flag === 'boolean') return flag
    if (typeof flag === 'string' || typeof flag === 'number') return isCheckConnectOk(flag)
  }
  return true
}

/** MT bridge no longer holds this session id (restart, expiry, or never connected). */
export function isMtSessionGoneMessage(message: string): boolean {
  const m = message.trim().toLowerCase()
  if (!m) return false
  return (
    m.includes('client with id')
    || m.includes('client not found')
    || (m.includes('not found') && (m.includes('client') || m.includes('id =')))
    || m.includes('unknown client')
    || m.includes('session not found')
    || m.includes('account not found')
  )
}

/** OrderSend/CheckConnect rejected because the MT terminal session is offline. */
export function isBrokerDisconnectedMessage(message: string): boolean {
  const m = message.trim().toLowerCase()
  if (!m) return false
  if (isMtSessionGoneMessage(message)) return true
  return m.includes('not connected') || m.includes('broker session is not connected')
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
  return /timeout|econnreset|econnrefused|fetch failed|network error|socket hang up|epipe|ehostunreach/.test(msg)
}

export const MT_SESSION_EXPIRED_HINT =
  'Trading session expired on the broker API. In Account Configuration, use Reconnect and enter your MT password (or remove and link the account again).'

function parseToken(body: unknown, fallbackId: string): string {
  if (typeof body === 'string') {
    const t = body.trim().replace(/^"|"$/g, '')
    if (t) return t
  }
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    const id = o.id ?? o.Id ?? o.token ?? o.Token
    if (id != null && String(id).trim()) return String(id).trim()
  }
  return fallbackId
}

function normalizeAccountSummary(body: unknown): AccountSummary {
  if (body == null || typeof body !== 'object') return {}
  const root = body as Record<string, unknown>
  const o = (root.result && typeof root.result === 'object')
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
    currency: typeof o.currency === 'string' ? o.currency : typeof o.Currency === 'string' ? o.Currency : undefined,
  }
}

interface PlatformPaths {
  orderSend: string
  orderModify: string
  orderClose: string
  quote: string
}

function pathsFor(platform: MtPlatform): PlatformPaths {
  if (platform === 'MT5') {
    return {
      orderSend: '/OrderSendSafe',
      orderModify: '/OrderModifySafe',
      orderClose: '/OrderCloseSafe',
      quote: '/GetQuote',
    }
  }
  return {
    orderSend: '/OrderSend',
    orderModify: '/OrderModify',
    orderClose: '/OrderClose',
    quote: '/Quote',
  }
}

export function mtPlatformFrom(s: string | null | undefined): MtPlatform {
  return s === 'MT4' ? 'MT4' : 'MT5'
}

export function hasMetatraderApiConfigured(): boolean {
  return isMtApiAuthConfigured(process.env)
}

export class MetatraderApiClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly timeoutMs: number
  private readonly paths: PlatformPaths
  readonly platform: MtPlatform

  constructor(
    platform: MtPlatform,
    authHeader: string,
    baseUrl?: string,
    timeoutMs: number = 30_000,
  ) {
    const header = authHeader.trim()
    if (!header) {
      throw new Error('MetatraderApiClient: Authorization header required')
    }
    this.platform = platform
    const defaultBase = platform === 'MT5' ? DEFAULT_MT5_BASE : DEFAULT_MT4_BASE
    this.baseUrl = normalizeBaseUrl(baseUrl ?? '', defaultBase)
    this.authHeader = normalizeAuthorizationHeader(header)
    this.timeoutMs = timeoutMs
    this.paths = pathsFor(platform)
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined | null>,
    timeoutMs?: number,
  ): Promise<T> {
    const qs = buildQuery(params)
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`
    const t = timeoutMs ?? this.timeoutMs
    const res = await request(url, {
      method: 'GET',
      headers: { Authorization: this.authHeader, accept: 'application/json, text/plain' },
      dispatcher: KEEP_ALIVE_AGENT,
      headersTimeout: t,
      bodyTimeout: t,
    })
    const text = await res.body.text()
    let body: unknown = null
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    const status = res.statusCode
    if (status < 200 || status >= 300) {
      const obj = (body && typeof body === 'object') ? body as Record<string, unknown> : null
      const msg = obj?.message ? String(obj.message)
        : obj?.error ? String(obj.error)
        : text || `HTTP ${status}`
      const code = obj?.code ? String(obj.code) : undefined
      throw new MetatraderApiError(msg, status, code)
    }
    return body as T
  }

  async connectEx(args: {
    id: string
    server: string
    login: string
    password: string
  }): Promise<string> {
    const userNum = Number(args.login)
    if (!Number.isFinite(userNum)) {
      throw new MetatraderApiError('Invalid MT login number', 400)
    }
    const raw = await this.get<unknown>('/ConnectEx', {
      id: args.id,
      user: userNum,
      password: args.password,
      server: args.server,
    })
    return parseToken(raw, args.id)
  }

  async connectByToken(id: string): Promise<void> {
    const raw = await this.get<unknown>('/ConnectByToken', { id })
    assertNoApiError(raw)
  }

  async ensureConnected(id: string): Promise<void> {
    const alive = await this.keepSessionAlive(id)
    if (!alive) throw new MetatraderApiError('Broker session is not connected', 502)
  }

  /**
   * Ping session; call ConnectByToken only when the session exists but CheckConnect
   * failed for a transient reason. When the bridge reports "client not found",
   * ConnectByToken cannot recreate the session — user must ConnectEx with password.
   */
  async keepSessionAlive(id: string): Promise<boolean> {
    try {
      await this.checkConnect(id)
      return true
    } catch (first) {
      if (isMtSessionGoneError(first)) {
        console.warn(`[metatraderapi] MT session gone id=${id} — ${MT_SESSION_EXPIRED_HINT}`)
        return false
      }
      const msg = first instanceof Error ? first.message : String(first)
      console.warn(`[metatraderapi] CheckConnect failed id=${id}: ${msg}; trying ConnectByToken`)
    }

    const MAX_RETRIES = 3
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.connectByToken(id)
        await this.checkConnect(id)
        return true
      } catch (err) {
        if (isMtSessionGoneError(err)) {
          console.warn(`[metatraderapi] MT session gone id=${id} (ConnectByToken attempt ${attempt + 1}) — ${MT_SESSION_EXPIRED_HINT}`)
          return false
        }
        if (attempt < MAX_RETRIES - 1 && isTransientMtApiError(err)) {
          const jitterMs = 1000 + Math.random() * 2000
          await new Promise(r => setTimeout(r, jitterMs))
          continue
        }
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[metatraderapi] keepSessionAlive failed id=${id} (attempt ${attempt + 1}): ${msg}`)
        return false
      }
    }
    return false
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
      if (isMtBridgeGlitchMessage(msg)) {
        console.warn(`[metatraderapi] verifyTradingReady bridge glitch id=${id}: ${msg}`)
        return true
      }
      console.warn(`[metatraderapi] verifyTradingReady failed id=${id}: ${msg}`)
      return false
    }
  }

  async disconnect(id: string): Promise<void> {
    await this.get<unknown>('/Disconnect', { id })
  }

  async openedOrders(id: string): Promise<unknown[]> {
    const raw = await this.get<unknown>('/OpenedOrders', { id })
    assertNoApiError(raw)
    return unwrapOrderList(raw)
  }

  /** Last ~100 closed orders in the current session only (see GET /ClosedOrders). */
  async closedOrders(id: string): Promise<unknown[]> {
    const raw = await this.get<unknown>('/ClosedOrders', { id })
    assertNoApiError(raw)
    return unwrapOrderList(raw)
  }

  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    const raw = await this.get<unknown>('/OrderHistory', { id, from, to })
    assertNoApiError(raw)
    return unwrapOrderList(raw)
  }

  async historyPositions(id: string, from: string, to: string): Promise<unknown[]> {
    const raw = await this.get<unknown>('/HistoryPositions', { id, from, to })
    assertNoApiError(raw)
    return unwrapOrderList(raw)
  }

  async orderHistoryPage(
    id: string,
    from: string,
    to: string,
    pageNumber: number,
    ordersPerPage = 500,
  ): Promise<{ orders: unknown[]; pagesCount: number }> {
    const raw = await this.get<unknown>('/OrderHistoryPagination', {
      id,
      from,
      to,
      pageNumber,
      ordersPerPage,
    })
    assertNoApiError(raw)
    if (raw && typeof raw === 'object') {
      const root = raw as Record<string, unknown>
      const result = root.result ?? root.Result
      if (result && typeof result === 'object') {
        const pr = result as Record<string, unknown>
        const orders = pr.Orders ?? pr.orders
        return {
          orders: Array.isArray(orders) ? orders : [],
          pagesCount: Number(pr.PagesCount ?? pr.pagesCount ?? 1) || 1,
        }
      }
    }
    return { orders: unwrapOrderList(raw), pagesCount: 1 }
  }

  async closedOrdersHistory(
    id: string,
    from: string,
    to: string,
    profile: MtHistoryProfile = 'dashboard',
  ): Promise<unknown[]> {
    const byKey = new Map<string, Record<string, unknown>>()
    const ingest = (rows: unknown[]) => ingestMtHistoryRows(byKey, rows, profile)

    try {
      let page = 0
      let pagesCount = 1
      while (page < pagesCount && page < 100) {
        const { orders, pagesCount: totalPages } = await this.orderHistoryPage(id, from, to, page)
        ingest(orders)
        pagesCount = Math.max(1, totalPages)
        if (orders.length === 0) break
        page += 1
      }
    } catch {
      /* optional */
    }

    const settled = profile === 'dashboard'
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
      if (r.status === 'fulfilled') ingest(r.value as unknown[])
    }
    return [...byKey.values()]
  }

  /** Recent closed history — last pagination page(s) + session closed orders. */
  async closedOrdersHistoryLite(
    id: string,
    from: string,
    to: string,
    profile: MtHistoryProfile = 'dashboard',
    maxPages = 2,
    ordersPerPage = 200,
  ): Promise<unknown[]> {
    const byKey = new Map<string, Record<string, unknown>>()
    const ingest = (rows: unknown[]) => ingestMtHistoryRows(byKey, rows, profile)

    try {
      ingest(await this.closedOrders(id) as unknown[])
    } catch {
      /* optional */
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
      /* fall through */
    }

    try {
      ingest(await this.orderHistory(id, from, to) as unknown[])
    } catch {
      /* ignore */
    }
    return [...byKey.values()]
  }

  async accountSummary(id: string): Promise<AccountSummary> {
    const raw = await this.get<unknown>('/AccountSummary', { id })
    assertNoApiError(raw)
    return normalizeAccountSummary(raw)
  }

  async checkConnect(id: string): Promise<void> {
    const checkTimeoutMs = Math.max(
      500,
      Math.min(5_000, Number(process.env.MT4API_CHECK_CONNECT_TIMEOUT_MS ?? 1_500)),
    )
    const raw = await this.get<unknown>('/CheckConnect', { id }, checkTimeoutMs)
    assertNoApiError(raw)
    if (!isCheckConnectOk(raw)) {
      throw new MetatraderApiError('Broker session is not connected', 502)
    }
  }

  symbolParams(id: string, symbol: string): Promise<SymbolParams> {
    return this.get<SymbolParams>('/SymbolParams', { id, symbol })
  }

  /** Returns the broker's full instrument list. Some servers return string[], others SymbolInfo[]. */
  symbols(id: string): Promise<unknown[]> {
    return this.get<unknown[]>('/Symbols', { id })
  }

  /**
   * Live bid/ask quote for a symbol. The MetatraderAPI proto names the fields
   * Bid/Ask/Time in PascalCase; some server builds also return camelCase. Normalise
   * both shapes here so callers always see `{ symbol, bid, ask, time }`.
   */
  async quote(id: string, symbol: string): Promise<QuoteResult> {
    // Endpoint name in the API2Trade / metatraderapi.dev REST surface is
    // `/GetQuote` (not `/Quote`). Calling `/Quote` returns HTTP 404 and breaks
    // anchor resolution for averaging-down ladders that don't carry an
    // explicit signal entry price.
    const raw = await this.get<unknown>(this.paths.quote, { id, symbol })
    assertNoApiError(raw)
    const root = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
    const r = (root.result && typeof root.result === 'object') ? root.result as Record<string, unknown> : root
    const bid = num(r.bid ?? r.Bid)
    const ask = num(r.ask ?? r.Ask)
    const time = typeof r.time === 'string' ? r.time : typeof r.Time === 'string' ? r.Time : undefined
    if (bid == null || ask == null || bid <= 0 || ask <= 0) {
      throw new MetatraderApiError(
        `Quote: invalid bid/ask for ${symbol} (bid=${String(r.Bid ?? r.bid)} ask=${String(r.Ask ?? r.ask)})`,
        200,
      )
    }
    return {
      symbol: typeof r.symbol === 'string' ? r.symbol : typeof r.Symbol === 'string' ? r.Symbol : symbol,
      bid,
      ask,
      time,
    }
  }

  async orderSend(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const MAX_ATTEMPTS = Math.max(1, Number(process.env.MT_ORDERSEND_MAX_ATTEMPTS ?? 3) || 3)
    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.orderSendOnce(id, args)
      } catch (err) {
        lastErr = err
        if (isBrokerDisconnectedMessage(err instanceof Error ? err.message : String(err))) throw err
        if (isMtSessionGoneError(err)) throw err
        const msg = err instanceof Error ? err.message : String(err)
        const retryable = isMtBridgeGlitchMessage(msg) || isTransientMtApiError(err)
        if (!retryable || attempt >= MAX_ATTEMPTS - 1) throw err
        if (isMtBridgeGlitchMessage(msg)) {
          await this.keepSessionAlive(id).catch(() => {})
        }
        const jitterMs = 600 + Math.random() * 900 + attempt * 400
        console.warn(
          `[metatraderapi] OrderSend retry id=${id} symbol=${args.symbol} attempt=${attempt + 1}/${MAX_ATTEMPTS}: ${msg}`,
        )
        await new Promise(r => setTimeout(r, jitterMs))
      }
    }
    throw lastErr instanceof Error ? lastErr : new MetatraderApiError(String(lastErr), 502)
  }

  private async orderSendOnce(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const op = String(args.operation)
    const px = Number(args.price)
    if (orderOperationRequiresPrice(op) && (!Number.isFinite(px) || px <= 0)) {
      throw new MetatraderApiError(
        `OrderSend: ${op} requires a positive price (got ${String(args.price)}); refusing to send price=0 to MetatraderAPI`,
        400,
      )
    }
    const raw = await this.get<unknown>(this.paths.orderSend, {
      id,
      symbol: args.symbol,
      operation: args.operation,
      volume: args.volume,
      price: Number.isFinite(px) ? px : 0,
      slippage: args.slippage ?? 20,
      stoploss: args.stoploss ?? 0,
      takeprofit: args.takeprofit ?? 0,
      comment: args.comment,
      expertID: args.expertID ?? 0,
      expiration: args.expiration,
      expirationType: args.expirationType,
    })
    assertNoApiError(raw)
    const out = normalizeOrderResponse(raw)
    if (!Number.isFinite(out.ticket) || out.ticket <= 0) {
      const preview = typeof raw === 'object' && raw !== null ? JSON.stringify(raw).slice(0, 500) : String(raw)
      throw new MetatraderApiError(`OrderSend returned no ticket (response: ${preview})`, 200)
    }
    return out
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const raw = await this.get<unknown>(this.paths.orderModify, {
      id,
      ticket: args.ticket,
      stoploss: args.stoploss ?? 0,
      takeprofit: args.takeprofit ?? 0,
      price: args.price ?? 0,
      expiration: args.expiration,
      expirationType: args.expirationType,
    })
    assertNoApiError(raw)
    return normalizeOrderResponse(raw)
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const raw = await this.get<unknown>(this.paths.orderClose, {
      id,
      ticket: args.ticket,
      lots: args.lots ?? 0,
      price: args.price ?? 0,
      slippage: args.slippage ?? 20,
    })
    assertNoApiError(raw)
    return normalizeOrderResponse(raw)
  }
}

const clientCache = new Map<MtPlatform, MetatraderApiClient | null>()

export function getMetatraderApi(platform: MtPlatform = 'MT5'): MetatraderApiClient | null {
  if (clientCache.has(platform)) return clientCache.get(platform) ?? null
  let authHeader: string
  try {
    authHeader = resolveBasicAuthHeader(process.env)
  } catch {
    clientCache.set(platform, null)
    return null
  }
  const defaultBase = platform === 'MT5' ? DEFAULT_MT5_BASE : DEFAULT_MT4_BASE
  const rawBase = platform === 'MT5'
    ? trimEnv(process.env.MT4API_MT5_BASE_URL)
    : trimEnv(process.env.MT4API_MT4_BASE_URL)
  const baseUrl = normalizeBaseUrl(rawBase, defaultBase)
  const client = new MetatraderApiClient(platform, authHeader, baseUrl)
  clientCache.set(platform, client)
  return client
}
