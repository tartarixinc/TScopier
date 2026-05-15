import { Agent, request } from 'undici'

/**
 * MetatraderAPI (metatraderapi.dev) Node client tuned for low order-send latency.
 *
 * - Singleton undici Agent keeps TLS-warm pools per platform host (mt4/mt5.mt4api.dev).
 * - Basic Auth; platform-specific paths (OrderSendSafe vs OrderSend). See docs/mt4api-endpoint-map.md.
 */

const DEFAULT_MT5_BASE = 'https://mt5.mt4api.dev'
const DEFAULT_MT4_BASE = 'https://mt4.mt4api.dev'

const KEEP_ALIVE_AGENT = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000,
  connections: 32,
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

function trimEnv(v: string | undefined): string {
  return (v ?? '').trim()
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
    this.baseUrl = (baseUrl ?? defaultBase).replace(/\/+$/, '')
    this.authHeader = normalizeAuthorizationHeader(header)
    this.timeoutMs = timeoutMs
    this.paths = pathsFor(platform)
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined | null>): Promise<T> {
    const qs = buildQuery(params)
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`
    const res = await request(url, {
      method: 'GET',
      headers: { Authorization: this.authHeader, accept: 'application/json, text/plain' },
      dispatcher: KEEP_ALIVE_AGENT,
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
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
    await this.get<unknown>('/ConnectByToken', { id })
  }

  async ensureConnected(id: string): Promise<void> {
    try {
      await this.checkConnect(id)
      return
    } catch {
      /* reconnect */
    }
    await this.connectByToken(id)
  }

  async disconnect(id: string): Promise<void> {
    await this.get<unknown>('/Disconnect', { id })
  }

  openedOrders(id: string): Promise<unknown[]> {
    return this.get<unknown[]>('/OpenedOrders', { id })
  }

  /** Recent closed deals / history (see docs: GET /ClosedOrders). */
  closedOrders(id: string): Promise<unknown[]> {
    return this.get<unknown[]>('/ClosedOrders', { id })
  }

  async accountSummary(id: string): Promise<AccountSummary> {
    const raw = await this.get<unknown>('/AccountSummary', { id })
    assertNoApiError(raw)
    return normalizeAccountSummary(raw)
  }

  checkConnect(id: string): Promise<string> {
    return this.get<string>('/CheckConnect', { id })
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
  const baseUrl = platform === 'MT5'
    ? (trimEnv(process.env.MT4API_MT5_BASE_URL) || DEFAULT_MT5_BASE)
    : (trimEnv(process.env.MT4API_MT4_BASE_URL) || DEFAULT_MT4_BASE)
  const client = new MetatraderApiClient(platform, authHeader, baseUrl)
  clientCache.set(platform, client)
  return client
}
