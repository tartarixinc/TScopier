import { Agent, request } from 'undici'

/**
 * MetatraderAPI (metatraderapi.dev) Node client tuned for low order-send latency.
 *
 * - Singleton undici Agent keeps a TLS-warm connection pool to api.metatraderapi.dev,
 *   so OrderSend round-trips skip TLS handshakes after the first call.
 * - All endpoints are GET with query parameters per
 *   https://docs.metatraderapi.dev/docs/metatrader-5-api.
 */

const DEFAULT_BASE_URL = 'https://api.metatraderapi.dev'

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
  }
  groupParams?: {
    minLot?: number
    maxLot?: number
    lotStep?: number
  }
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

export class MetatraderApiClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL, timeoutMs: number = 30_000) {
    if (!apiKey) throw new Error('MetatraderApiClient: apiKey is required')
    this.apiKey = apiKey
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined | null>): Promise<T> {
    const qs = buildQuery(params)
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`
    const res = await request(url, {
      method: 'GET',
      headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
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

  openedOrders(id: string): Promise<unknown[]> {
    return this.get<unknown[]>('/OpenedOrders', { id })
  }

  accountSummary(id: string): Promise<AccountSummary> {
    return this.get<AccountSummary>('/AccountSummary', { id })
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

  async orderSend(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const op = String(args.operation)
    const px = Number(args.price)
    if (orderOperationRequiresPrice(op) && (!Number.isFinite(px) || px <= 0)) {
      throw new MetatraderApiError(
        `OrderSend: ${op} requires a positive price (got ${String(args.price)}); refusing to send price=0 to MetatraderAPI`,
        400,
      )
    }
    const raw = await this.get<unknown>('/OrderSend', {
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
    const raw = await this.get<unknown>('/OrderModify', {
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
    const raw = await this.get<unknown>('/OrderClose', {
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

let cachedClient: MetatraderApiClient | null = null

export function getMetatraderApi(): MetatraderApiClient | null {
  if (cachedClient) return cachedClient
  const apiKey = process.env.METATRADERAPI_KEY?.trim() ?? ''
  if (!apiKey) return null
  const baseUrl = process.env.METATRADERAPI_BASE_URL?.trim() || DEFAULT_BASE_URL
  cachedClient = new MetatraderApiClient(apiKey, baseUrl)
  return cachedClient
}
