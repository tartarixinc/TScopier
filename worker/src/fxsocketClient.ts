import { Agent, request } from 'undici'
import { isMtBridgeGlitchMessage } from './brokerConnectError'
import { ingestMtHistoryRows, type MtHistoryProfile } from './mtTradeFields'

/**
 * FxSocket MT5 REST client for the worker.
 *
 * - Account linking: POST/GET/DELETE https://api.fxsocket.com/v1/accounts
 * - Trading: https://api.fxsocket.com/mt4/{accountId}/… or …/mt5/{accountId}/…
 * - Auth: X-API-Key header (FXSOCKET_API_KEY)
 */

const DEFAULT_BASE_URL = 'https://api.fxsocket.com'

const FXSOCKET_HTTP_CONNECTIONS = Math.max(
  8,
  Math.min(512, Number(process.env.FXSOCKET_HTTP_CONNECTIONS ?? 128)),
)

const KEEP_ALIVE_AGENT = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connections: FXSOCKET_HTTP_CONNECTIONS,
  pipelining: 1,
})

/** MetaTrader platform for FxSocket per-account REST paths. */
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

function orderOperationRequiresPrice(operation: string): boolean {
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
  [key: string]: unknown
}

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

export interface QuoteResult {
  symbol: string
  bid: number
  ask: number
  time?: string
}

export class FxsocketApiError extends Error {
  status: number
  code?: string
  commandId?: number

  constructor(message: string, status: number, code?: string, commandId?: number) {
    super(message)
    this.name = 'FxsocketApiError'
    this.status = status
    this.code = code
    this.commandId = commandId
  }
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
 * Normalize order responses from FxSocket ({ order, deal, success }) and legacy
 * MT REST shapes ({ ticket, Ticket, result: { … } }) into camelCase OrderResult.
 */
export function normalizeOrderResponse(body: unknown): OrderResult {
  if (body == null || typeof body !== 'object') {
    return { ticket: NaN }
  }
  const root = body as Record<string, unknown>

  let o: Record<string, unknown> = root
  if ('result' in root && root.result != null && typeof root.result === 'object') {
    o = root.result as Record<string, unknown>
  }

  const ticketRaw =
    o.ticket
    ?? o.Ticket
    ?? o.order
    ?? o.Order
    ?? o.orderId
    ?? o.OrderId
    ?? o.deal
    ?? o.Deal
    ?? nestedTicket(o, 'deal')
    ?? nestedTicket(o, 'Deal')
    ?? nestedTicket(o, 'DealInternalIn')
    ?? nestedTicket(o, 'ex')

  const ticket = typeof ticketRaw === 'number' ? ticketRaw : Number(ticketRaw)

  return {
    ticket: Number.isFinite(ticket) ? ticket : NaN,
    openPrice: num(o.openPrice ?? o.OpenPrice ?? o.price ?? o.Price),
    stopLoss: num(o.stopLoss ?? o.StopLoss),
    takeProfit: num(o.takeProfit ?? o.TakeProfit),
    lots: num(o.lots ?? o.Lots ?? o.volume ?? o.Volume),
    symbol: typeof o.symbol === 'string' ? o.symbol : typeof o.Symbol === 'string' ? o.Symbol : undefined,
    orderType: typeof o.orderType === 'string' ? o.orderType : typeof o.OrderType === 'string' ? String(o.OrderType) : typeof o.type === 'string' ? o.type : undefined,
    state: typeof o.state === 'string' ? o.state : typeof o.State === 'string' ? String(o.State) : undefined,
    closePrice: num(o.closePrice ?? o.ClosePrice),
    profit: num(o.profit ?? o.Profit),
    swap: num(o.swap ?? o.Swap),
    commission: num(o.commission ?? o.Commission),
    fee: num(o.fee ?? o.Fee),
    comment: typeof o.comment === 'string' ? o.comment : typeof o.Comment === 'string' ? o.Comment : undefined,
  }
}

function parseErrorEnvelope(body: unknown): { message: string; code?: string; commandId?: number } {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    if (o.detail != null) {
      const detail = o.detail
      if (typeof detail === 'string') {
        return { message: detail, code: o.error != null ? String(o.error) : undefined }
      }
      if (Array.isArray(detail)) return { message: detail.map(String).join('; ') }
    }
    const message = String(o.message ?? o.error ?? o.Message ?? 'FxSocket request failed')
    const code = o.error != null ? String(o.error) : o.code != null ? String(o.code) : undefined
    const commandId = num(o.command_id ?? o.commandId)
    return { message, code, commandId }
  }
  if (typeof body === 'string' && body.trim()) return { message: body.trim() }
  return { message: 'FxSocket request failed' }
}

function assertNoApiError(body: unknown): void {
  if (body == null || typeof body !== 'object') return
  const root = body as Record<string, unknown>

  if (root.success === false) {
    const msg = String(root.retcodeDescription ?? root.message ?? 'Order rejected').trim()
    const code = root.retcode != null ? String(root.retcode) : undefined
    throw new FxsocketApiError(msg || 'Order rejected', 200, code)
  }

  const err = root.error
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const m = String(e.message ?? e.Message ?? '').trim()
    if (m && m !== 'null' && m !== 'undefined') {
      throw new FxsocketApiError(m, 200, e.code != null ? String(e.code) : undefined)
    }
  }

  if (!('result' in root) && !('ticket' in root) && !('Ticket' in root) && !('order' in root) && !('deal' in root)) {
    const m = root.message ?? root.Message
    const code = root.code ?? root.Code
    if (typeof m === 'string' && m.trim()) {
      throw new FxsocketApiError(m.trim(), 200, code != null ? String(code) : undefined)
    }
  }
}

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
    minLot: readNum(grp, 'minLot', 'MinLot', 'min_lot', 'volume_min', 'VolumeMin', 'volumeMin', 'volumeMin'),
    maxLot: readNum(grp, 'maxLot', 'MaxLot', 'max_lot', 'volume_max', 'VolumeMax', 'volumeMax', 'volumeMax'),
    lotStep: readNum(grp, 'lotStep', 'LotStep', 'lot_step', 'volume_step', 'VolumeStep', 'volumeStep', 'volumeStep'),
  }
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

function normalizeBaseUrl(raw: string, fallback: string): string {
  let u = trimEnv(raw)
  if (!u) return fallback.replace(/\/+$/, '')
  u = u.replace(/^[<\[(]+/, '').replace(/[>\])]+$/, '')
  u = u.replace(/\/+$/, '')
  try {
    const parsed = new URL(u.includes('://') ? u : `https://${u}`)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    console.warn(`[fxsocketClient] invalid base URL "${raw.slice(0, 80)}", using default`)
    return fallback.replace(/\/+$/, '')
  }
}

function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = trimEnv(env.FXSOCKET_API_KEY)
  if (!key) {
    throw new Error('FXSOCKET_API_KEY is required')
  }
  return key
}

export function hasFxsocketConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    resolveApiKey(env)
    return true
  } catch {
    return false
  }
}

export function isCheckConnectOk(body: unknown): boolean {
  if (body === true) return true
  if (body === false) return false
  if (typeof body === 'number') return body > 0
  if (typeof body === 'string') {
    const s = body.trim().toLowerCase()
    if (!s) return false
    if (s === 'connecting') return false
    if (s === 'true' || s === 'ok' || s === 'connected' || s === 'yes' || s === '1') return true
    if (
      s === 'false'
      || s === '0'
      || s.includes('not connected')
      || s.includes('disconnected')
      || s.includes('notconnected')
      || s === 'error'
    ) {
      return false
    }
    return true
  }
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>
    const status = r.status ?? r.Status
    if (typeof status === 'string') {
      const s = status.trim().toLowerCase()
      if (s === 'connected') return true
      if (s === 'error' || s === 'disconnected') return false
      if (s === 'connecting') return false
    }
    const nested = r.result ?? r.Result
    if (nested !== undefined && nested !== r) return isCheckConnectOk(nested)
    const flag = r.connected ?? r.Connected ?? r.isConnected ?? r.IsConnected
    if (typeof flag === 'boolean') return flag
    if (typeof flag === 'string' || typeof flag === 'number') return isCheckConnectOk(flag)
  }
  return true
}

export function isMtSessionGoneMessage(message: string): boolean {
  const m = message.trim().toLowerCase()
  if (!m) return false
  return (
    m.includes('client with id')
    || m.includes('client not found')
    || (m.includes('not found') && (m.includes('client') || m.includes('account') || m.includes('id')))
    || m.includes('unknown client')
    || m.includes('session not found')
    || m.includes('account not found')
    || m.includes('terminal is down')
    || m.includes('account or endpoint not found')
    || m.includes('unlink')
  )
}

export function isBrokerDisconnectedMessage(message: string): boolean {
  const m = message.trim().toLowerCase()
  if (!m) return false
  if (isMtSessionGoneMessage(message)) return true
  return (
    m.includes('not connected')
    || m.includes('broker session is not connected')
    || m.includes('status: disconnected')
    || m.includes('status: error')
  )
}

export function isMtSessionGoneError(err: unknown): boolean {
  if (err instanceof FxsocketApiError) return isMtSessionGoneMessage(err.message) || err.status === 404
  if (err instanceof Error) return isMtSessionGoneMessage(err.message)
  return isMtSessionGoneMessage(String(err))
}

export function isTransientMtApiError(err: unknown): boolean {
  if (err instanceof FxsocketApiError) {
    const s = err.status
    if (s === 502 || s === 503 || s === 504) return true
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /timeout|econnreset|econnrefused|fetch failed|network error|socket hang up|epipe|ehostunreach|abort/.test(msg)
}

/** FxSocket / upstream rate limit (also matches Supabase-style throttle text). */
export function isApiThrottleError(err: unknown): boolean {
  if (err instanceof FxsocketApiError && err.status === 429) return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /throttl|rate limit|too many requests|expected available in/i.test(msg)
}

export function parseApiThrottleBackoffMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err)
  const m = /expected available in (\d+)\s*seconds?/i.exec(msg)
  if (m) return Math.max(1000, Number(m[1]) * 1000 + 500)
  const raw = Number(process.env.BROKER_API_THROTTLE_BACKOFF_MS ?? 8000)
  return Number.isFinite(raw) && raw >= 1000 ? raw : 8000
}

const checkConnectSoftUntil = new Map<string, number>()
const checkConnectLastAt = new Map<string, number>()

export function checkConnectGlobalMinMs(): number {
  return Math.max(
    5000,
    Math.min(120_000, Number(process.env.FXSOCKET_CHECK_CONNECT_MIN_MS ?? 25_000)),
  )
}

/** Test helper — reset per-account checkConnect pacing. */
export function resetCheckConnectPacing(accountId?: string): void {
  if (accountId) {
    checkConnectSoftUntil.delete(accountId)
    checkConnectLastAt.delete(accountId)
    return
  }
  checkConnectSoftUntil.clear()
  checkConnectLastAt.clear()
}

export const MT_SESSION_EXPIRED_HINT =
  'Trading session expired on the broker API. In Account Configuration, use Reconnect and enter your MT password (or remove and link the account again).'

type KeepSessionAliveStatus =
  | 'alive'
  | 'session_gone'
  | 'token_reconnect_failed'

function formatMtApiDateTime(d: Date): string {
  return d.toISOString().slice(0, 19)
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
    freeMargin: num(o.freeMargin ?? o.FreeMargin ?? o.marginFree ?? o.MarginFree ?? o.free_margin),
    marginLevel: num(o.marginLevel ?? o.MarginLevel ?? o.margin_level),
    leverage: num(o.leverage ?? o.Leverage),
    currency: typeof o.currency === 'string' ? o.currency : typeof o.Currency === 'string' ? o.Currency : undefined,
  }
}

function symbolInfoToParams(info: Record<string, unknown>, symbol: string): SymbolParams {
  return {
    symbolName: typeof info.symbol === 'string' ? info.symbol : symbol,
    symbol: {
      digits: readNum(info, 'digits', 'Digits'),
      point: readNum(info, 'point', 'Point'),
      contractSize: readNum(info, 'contractSize', 'ContractSize', 'contract_size'),
      stopsLevel: readNum(info, 'stopsLevel', 'StopsLevel', 'stops_level'),
      freezeLevel: readNum(info, 'freezeLevel', 'FreezeLevel', 'freeze_level'),
    },
    groupParams: {
      minLot: readNum(info, 'volumeMin', 'VolumeMin', 'minLot', 'MinLot'),
      maxLot: readNum(info, 'volumeMax', 'VolumeMax', 'maxLot', 'MaxLot'),
      lotStep: readNum(info, 'volumeStep', 'VolumeStep', 'lotStep', 'LotStep'),
    },
    ...info,
  }
}

export function mtPlatformFrom(value: string | null | undefined): MtPlatform {
  return String(value ?? '').trim().toUpperCase() === 'MT4' ? 'MT4' : 'MT5'
}

function accountApiPathSegment(platform: MtPlatform): 'mt4' | 'mt5' {
  return platform === 'MT4' ? 'mt4' : 'mt5'
}

interface V1Account {
  id: string
  platform: string
  status: string
  error: string
}

function normalizeV1Account(raw: unknown): V1Account {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return {
    id: o.id != null ? String(o.id) : '',
    platform: o.platform != null ? String(o.platform) : '',
    status: o.status != null ? String(o.status) : '',
    error: o.error != null ? String(o.error) : '',
  }
}

export class FxsocketBrokerClient {
  private readonly baseUrl: string
  private readonly v1BaseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly platformCache = new Map<string, MtPlatform>()

  constructor(
    _platform: MtPlatform = 'MT5',
    apiKey?: string,
    baseUrl?: string,
    timeoutMs: number = 30_000,
  ) {
    const key = (apiKey ?? resolveApiKey()).trim()
    if (!key) throw new Error('FxsocketBrokerClient: FXSOCKET_API_KEY required')
    this.apiKey = key
    this.baseUrl = normalizeBaseUrl(baseUrl ?? trimEnv(process.env.FXSOCKET_BASE_URL), DEFAULT_BASE_URL)
    this.v1BaseUrl = `${this.baseUrl}/v1`
    this.timeoutMs = timeoutMs
  }

  /** Seed platform from broker_accounts so REST calls use /mt4/ or /mt5/ without a v1 round-trip. */
  seedPlatformCache(id: string, platform: MtPlatform | string | null | undefined): void {
    const trimmed = String(id ?? '').trim()
    if (!trimmed) return
    this.platformCache.set(trimmed, mtPlatformFrom(platform))
  }

  private async resolvePlatform(id: string, hint?: MtPlatform): Promise<MtPlatform> {
    if (hint) {
      this.platformCache.set(id, hint)
      return hint
    }
    const cached = this.platformCache.get(id)
    if (cached) return cached
    try {
      const v1 = await this.getV1Account(id)
      const platform = mtPlatformFrom(v1.platform)
      this.platformCache.set(id, platform)
      return platform
    } catch {
      return 'MT5'
    }
  }

  private async accountBase(accountId: string, platformHint?: MtPlatform): Promise<string> {
    const id = String(accountId ?? '').trim()
    if (!id) throw new FxsocketApiError('account id required', 400)
    const platform = await this.resolvePlatform(id, platformHint)
    return `${this.baseUrl}/${accountApiPathSegment(platform)}/${encodeURIComponent(id)}`
  }

  async getV1Account(id: string): Promise<V1Account> {
    const raw = await this.get<unknown>(
      `${this.v1BaseUrl}/accounts/${encodeURIComponent(id)}`,
    )
    assertNoApiError(raw)
    return normalizeV1Account(raw)
  }

  private async http<T>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    opts?: { body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    const t = opts?.timeoutMs ?? this.timeoutMs
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      accept: 'application/json, text/plain',
    }
    let body: string | undefined
    if (opts?.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }

    const res = await request(url, {
      method,
      headers,
      body,
      dispatcher: KEEP_ALIVE_AGENT,
      headersTimeout: t,
      bodyTimeout: t,
    })

    const text = await res.body.text()
    let parsed: unknown = null
    if (text) {
      try { parsed = JSON.parse(text) } catch { parsed = text }
    }

    const status = res.statusCode
    if (status < 200 || status >= 300) {
      const err = parseErrorEnvelope(parsed)
      if (status === 404 && (url.includes('/mt5/') || url.includes('/mt4/'))) {
        throw new FxsocketApiError(
          'FxSocket account or endpoint not found. Check the account UUID and that the terminal is running.',
          404,
          err.code,
          err.commandId,
        )
      }
      throw new FxsocketApiError(err.message || text || `HTTP ${status}`, status, err.code, err.commandId)
    }
    return parsed as T
  }

  private get<T>(path: string, params?: Record<string, string | number | undefined | null>, timeoutMs?: number): Promise<T> {
    const out = new URLSearchParams()
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue
        out.set(k, String(v))
      }
    }
    const qs = out.toString()
    return this.http<T>('GET', `${path}${qs ? `?${qs}` : ''}`, { timeoutMs })
  }

  private post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    return this.http<T>('POST', path, { body, timeoutMs })
  }

  async connectEx(args: {
    id: string
    server: string
    login: string
    password: string
  }): Promise<string> {
    const loginNum = Number(String(args.login).trim())
    if (!Number.isFinite(loginNum) || loginNum < 1) {
      throw new FxsocketApiError('Invalid MT5 login number', 400)
    }
    const payload: Record<string, unknown> = {
      login: loginNum,
      password: args.password,
      server: args.server.trim(),
    }
    const nickname = args.id?.trim()
    if (nickname) payload.nickname = nickname

    const raw = await this.http<unknown>('POST', `${this.v1BaseUrl}/accounts`, {
      body: payload,
      timeoutMs: 120_000,
    })
    assertNoApiError(raw)
    const acct = normalizeV1Account(raw)
    if (!acct.id) {
      throw new FxsocketApiError('FxSocket link succeeded but no account id was returned.', 502)
    }
    return acct.id
  }

  /** No-op for FxSocket — sessions are managed server-side; kept for compat. */
  async connectByToken(_id: string): Promise<void> {
    return
  }

  async ensureConnected(id: string): Promise<void> {
    const alive = await this.keepSessionAlive(id)
    if (!alive) throw new FxsocketApiError('Broker session is not connected', 502)
  }

  async keepSessionAlive(id: string): Promise<boolean> {
    const status = await this.keepSessionAliveDetailed(id)
    return status === 'alive'
  }

  async keepSessionAliveDetailed(id: string): Promise<KeepSessionAliveStatus> {
    try {
      await this.checkConnect(id)
      return 'alive'
    } catch (first) {
      if (isMtSessionGoneError(first)) {
        console.warn(`[fxsocketClient] MT session gone id=${id} — ${MT_SESSION_EXPIRED_HINT}`)
        return 'session_gone'
      }
      const msg = first instanceof Error ? first.message : String(first)
      console.warn(`[fxsocketClient] CheckConnect failed id=${id}: ${msg}`)
      return 'token_reconnect_failed'
    }
  }

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
        console.warn(`[fxsocketClient] verifyTradingReady bridge glitch id=${id}: ${msg}`)
        return true
      }
      console.warn(`[fxsocketClient] verifyTradingReady failed id=${id}: ${msg}`)
      return false
    }
  }

  async disconnect(id: string): Promise<void> {
    try {
      await this.http('DELETE', `${this.v1BaseUrl}/accounts/${encodeURIComponent(id)}`, { timeoutMs: 30_000 })
    } catch (e) {
      console.warn('[fxsocketClient] disconnect failed:', e instanceof Error ? e.message : e)
    }
  }

  async openedOrders(id: string): Promise<unknown[]> {
    const raw = await this.get<unknown>(`${await this.accountBase(id)}/OpenedOrders`)
    assertNoApiError(raw)
    return unwrapOrderList(raw)
  }

  /** FxSocket has no /ClosedOrders — approximate with recent OrderHistory. */
  async closedOrders(id: string): Promise<unknown[]> {
    const to = formatMtApiDateTime(new Date())
    const from = formatMtApiDateTime(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    try {
      const rows = await this.orderHistory(id, from, to)
      return rows.slice(-100)
    } catch {
      return []
    }
  }

  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    const raw = await this.get<unknown>(`${await this.accountBase(id)}/OrderHistory`, { from, to })
    assertNoApiError(raw)
    return unwrapOrderList(raw)
  }

  /** FxSocket has no /HistoryPositions — filter deal history for position closes. */
  async historyPositions(id: string, from: string, to: string): Promise<unknown[]> {
    try {
      const rows = await this.orderHistory(id, from, to)
      return rows.filter((row) => {
        if (!row || typeof row !== 'object') return false
        const r = row as Record<string, unknown>
        const entry = String(r.entry ?? r.Entry ?? '').toLowerCase()
        return entry === 'out' || entry === 'out_by' || entry === 'inout'
      })
    } catch {
      return []
    }
  }

  async orderHistoryPage(
    id: string,
    from: string,
    to: string,
    pageNumber: number,
    ordersPerPage = 500,
  ): Promise<{ orders: unknown[]; pagesCount: number }> {
    const all = await this.orderHistory(id, from, to)
    const pagesCount = Math.max(1, Math.ceil(all.length / ordersPerPage))
    const page = Math.max(0, Math.min(pageNumber, pagesCount - 1))
    const start = page * ordersPerPage
    return {
      orders: all.slice(start, start + ordersPerPage),
      pagesCount,
    }
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
    const raw = await this.get<unknown>(`${await this.accountBase(id)}/AccountSummary`)
    assertNoApiError(raw)
    return normalizeAccountSummary(raw)
  }

  async checkConnect(id: string): Promise<void> {
    const trimmed = String(id ?? '').trim()
    if (!trimmed) throw new FxsocketApiError('account id required', 400)
    const now = Date.now()
    const softUntil = checkConnectSoftUntil.get(trimmed) ?? 0
    if (now < softUntil) return

    const minGap = checkConnectGlobalMinMs()
    const lastAt = checkConnectLastAt.get(trimmed) ?? 0
    if (now - lastAt < minGap) return

    const checkTimeoutMs = Math.max(
      500,
      Math.min(5_000, Number(process.env.FXSOCKET_CHECK_CONNECT_TIMEOUT_MS ?? 1_500)),
    )
    try {
      const raw = await this.get<unknown>(
        `${this.v1BaseUrl}/accounts/${encodeURIComponent(trimmed)}`,
        undefined,
        checkTimeoutMs,
      )
      assertNoApiError(raw)
      const acct = normalizeV1Account(raw)
      this.platformCache.set(trimmed, mtPlatformFrom(acct.platform))
      if (acct.status === 'error') {
        throw new FxsocketApiError(acct.error || 'Broker session is not connected', 502)
      }
      if (acct.status === 'disconnected') {
        throw new FxsocketApiError('Broker session is not connected', 502)
      }
      if (!isCheckConnectOk(acct.status)) {
        throw new FxsocketApiError('Broker session is not connected', 502)
      }
      checkConnectLastAt.set(trimmed, Date.now())
      checkConnectSoftUntil.delete(trimmed)
    } catch (err) {
      if (isApiThrottleError(err)) {
        const backoff = parseApiThrottleBackoffMs(err)
        checkConnectSoftUntil.set(trimmed, Date.now() + backoff)
        console.warn(
          `[fxsocketClient] CheckConnect throttled id=${trimmed}; backing off ${backoff}ms`,
        )
        return
      }
      throw err
    }
  }

  async symbolParams(id: string, symbol: string): Promise<SymbolParams> {
    const raw = await this.get<Record<string, unknown>>(
      `${await this.accountBase(id)}/SymbolInfo`,
      { symbol },
    )
    return symbolInfoToParams(raw ?? {}, symbol)
  }

  async symbols(id: string): Promise<unknown[]> {
    const raw = await this.get<unknown>(`${await this.accountBase(id)}/symbols`)
    return Array.isArray(raw) ? raw : unwrapOrderList(raw)
  }

  async quote(id: string, symbol: string): Promise<QuoteResult> {
    const raw = await this.get<unknown>(`${await this.accountBase(id)}/getQuote`, { symbol })
    assertNoApiError(raw)
    const root = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
    const r = (root.result && typeof root.result === 'object') ? root.result as Record<string, unknown> : root
    const bid = num(r.bid ?? r.Bid)
    const ask = num(r.ask ?? r.Ask)
    const time = typeof r.time === 'string' ? r.time : typeof r.Time === 'string' ? r.Time : undefined
    if (bid == null || ask == null || bid <= 0 || ask <= 0) {
      throw new FxsocketApiError(
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
          `[fxsocketClient] OrderSend retry id=${id} symbol=${args.symbol} attempt=${attempt + 1}/${MAX_ATTEMPTS}: ${msg}`,
        )
        await new Promise(r => setTimeout(r, jitterMs))
      }
    }
    throw lastErr instanceof Error ? lastErr : new FxsocketApiError(String(lastErr), 502)
  }

  private async orderSendOnce(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const op = String(args.operation)
    const px = Number(args.price)
    if (orderOperationRequiresPrice(op) && (!Number.isFinite(px) || px <= 0)) {
      throw new FxsocketApiError(
        `OrderSend: ${op} requires a positive price (got ${String(args.price)}); refusing to send price=0`,
        400,
      )
    }
    const payload: Record<string, unknown> = {
      symbol: args.symbol,
      operation: args.operation,
      volume: args.volume,
      slippage: args.slippage ?? 20,
      comment: args.comment ?? '',
      expertId: args.expertID ?? 0,
    }
    if (Number.isFinite(px) && px > 0) payload.price = px
    if (args.stoploss != null && args.stoploss !== 0) payload.stopLoss = args.stoploss
    if (args.takeprofit != null && args.takeprofit !== 0) payload.takeProfit = args.takeprofit
    if (args.expiration) payload.expiration = args.expiration

    const raw = await this.post<unknown>(`${await this.accountBase(id)}/OrderSend`, payload, 90_000)
    assertNoApiError(raw)
    const out = normalizeOrderResponse(raw)
    if (!Number.isFinite(out.ticket) || out.ticket <= 0) {
      const preview = typeof raw === 'object' && raw !== null ? JSON.stringify(raw).slice(0, 500) : String(raw)
      throw new FxsocketApiError(`OrderSend returned no ticket (response: ${preview})`, 200)
    }
    return out
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const MAX_ATTEMPTS = Math.max(1, Number(process.env.MT_ORDERMODIFY_MAX_ATTEMPTS ?? 3) || 3)
    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.orderModifyOnce(id, args)
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
          `[fxsocketClient] OrderModify retry id=${id} ticket=${args.ticket}`
          + ` attempt=${attempt + 1}/${MAX_ATTEMPTS}: ${msg}`,
        )
        await new Promise(r => setTimeout(r, jitterMs))
      }
    }
    throw lastErr instanceof Error ? lastErr : new FxsocketApiError(String(lastErr), 502)
  }

  private async orderModifyOnce(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const payload: Record<string, unknown> = { ticket: args.ticket }
    if (args.stoploss != null) payload.stopLoss = args.stoploss
    if (args.takeprofit != null) payload.takeProfit = args.takeprofit
    if (args.price != null) payload.price = args.price
    if (args.expiration) payload.expiration = args.expiration

    const raw = await this.post<unknown>(`${await this.accountBase(id)}/OrderModify`, payload, 90_000)
    assertNoApiError(raw)
    return normalizeOrderResponse(raw)
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const payload: Record<string, unknown> = {
      ticket: args.ticket,
      slippage: args.slippage ?? 20,
    }
    if (args.lots != null && args.lots > 0) payload.volume = args.lots
    if (args.price != null && args.price > 0) payload.price = args.price

    const raw = await this.post<unknown>(`${await this.accountBase(id)}/OrderClose`, payload, 90_000)
    assertNoApiError(raw)
    return normalizeOrderResponse(raw)
  }
}

let clientSingleton: FxsocketBrokerClient | null | undefined

export function getFxsocketClient(): FxsocketBrokerClient | null {
  if (clientSingleton !== undefined) return clientSingleton
  try {
    clientSingleton = new FxsocketBrokerClient('MT5')
    return clientSingleton
  } catch {
    clientSingleton = null
    return null
  }
}
