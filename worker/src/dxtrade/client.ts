/**
 * DXtrade REST client (one per linked account).
 *
 * Auth is a session token from `POST /login`, sent as `Authorization: DXAPI <token>`. A non-empty
 * User-Agent is required or the gateway answers 403. Limits: about one login per second per IP and
 * about ten requests per second per session; the client paces both. A 401 triggers one re-login.
 *
 * Writes are never retried blindly. A timeout or 5xx on an order write surfaces as an "uncertain"
 * error so the caller can confirm the outcome through order history by client order code.
 */
import {
  assertPublicHost,
  normalizeDxtradeServerUrl,
  resolveHostAddresses,
  type HostResolver,
} from './serverUrl'
import { matchInstrument, type DxtradeInstrument } from './symbols'

export interface DxtradeCredential {
  accountId: string
  serverUrl: string
  username: string
  domain: string
  password: string
  /** `clearing:account` */
  accountCode: string
  isPositionBased: boolean
}

export class DxtradeApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'DxtradeApiError'
    this.status = status
    this.code = code
  }
  /** True when the server may have processed the request (no answer, or a 5xx). */
  get uncertain(): boolean {
    return this.status === 0 || this.status >= 500
  }
}

export type Json = Record<string, unknown>

export interface DxtradeClientOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  resolveHost?: HostResolver
  /** Skip the DNS safety check (tests only). */
  skipHostCheck?: boolean
  requestTimeoutMs?: number
}

const USER_AGENT = 'TScopier/1.0 (+https://tscopier.ai)'
const LOGIN_GAP_MS = 1100
const REQUEST_GAP_MS = 110
const DEFAULT_TIMEOUT_MS = 15_000

// Logins are limited per IP, so every client in this process shares one gate.
let lastLoginAt = 0
let loginGate: Promise<void> = Promise.resolve()

export function resetDxtradeLoginGateForTests(): void {
  lastLoginAt = 0
  loginGate = Promise.resolve()
}

export function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

export function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** List responses are either a bare array or an object wrapping it under a named key. */
export function rows(data: unknown, ...keys: string[]): Json[] {
  if (Array.isArray(data)) return data.filter(item => item && typeof item === 'object') as Json[]
  const obj = asRecord(data)
  for (const key of keys) {
    const inner = obj[key]
    if (Array.isArray(inner)) return inner.filter(item => item && typeof item === 'object') as Json[]
  }
  return []
}

function parseTimeoutMs(value: unknown, now: number): number {
  const text = String(value ?? '').trim()
  const interval = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/.exec(text)
  if (interval) {
    const days = Number(interval[1] ?? 0)
    return (((days * 24 + Number(interval[2])) * 60 + Number(interval[3])) * 60 + Number(interval[4])) * 1000
  }
  const date = Date.parse(text)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  const seconds = Number(text)
  if (Number.isFinite(seconds) && seconds > 0) return seconds > 100_000 ? seconds : seconds * 1000
  return 5 * 60_000
}

export function friendlyDxtradeError(error: unknown): string {
  if (error instanceof DxtradeApiError) {
    if (error.status === 401) return 'The broker rejected the DXtrade username, domain or password'
    if (error.status === 403 && error.code !== '99') return "The broker's DXtrade server blocked the request"
    if (error.status === 429) return "The broker's DXtrade server is rate limiting requests"
    if (error.status === 500 && error.code === '110') {
      return 'The broker refused the DXtrade login. The password may have expired or two-factor sign-in may be required'
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export interface OpenOrdersResult {
  orders: Json[]
  etag: string | null
}

export class DxtradeClient {
  private token: string | null = null
  private tokenExpiresAt = 0
  private loginInFlight: Promise<void> | null = null
  private lastRequestAt = 0
  private paceChain: Promise<void> = Promise.resolve()
  private hostChecked = false
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly resolveHost: HostResolver
  private readonly skipHostCheck: boolean
  private readonly timeoutMs: number
  readonly serverUrl: string

  constructor(readonly credential: DxtradeCredential, options: DxtradeClientOptions = {}) {
    const normalized = normalizeDxtradeServerUrl(credential.serverUrl)
    if (!normalized.ok) throw new Error(normalized.error)
    this.serverUrl = normalized.url
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.resolveHost = options.resolveHost ?? resolveHostAddresses
    this.skipHostCheck = options.skipHostCheck === true
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private get accountPath(): string {
    return `/accounts/${encodeURIComponent(this.credential.accountCode)}`
  }

  // ── session ──────────────────────────────────────────────────────────────

  async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight
    const run = (async () => {
      if (!this.skipHostCheck && !this.hostChecked) {
        await assertPublicHost(this.serverUrl, this.resolveHost)
        this.hostChecked = true
      }
      const previous = loginGate
      let release!: () => void
      loginGate = new Promise<void>(resolve => { release = resolve })
      try {
        await previous
        const wait = lastLoginAt + LOGIN_GAP_MS - this.now()
        if (wait > 0) await this.sleep(wait)
        lastLoginAt = this.now()
        const { data } = await this.send('POST', '/login', {
          body: {
            username: this.credential.username,
            domain: this.credential.domain,
            password: this.credential.password,
          },
        })
        const payload = asRecord(data)
        const token = String(payload.sessionToken ?? '').trim()
        if (!token) throw new DxtradeApiError('The broker did not return a DXtrade session', 0)
        this.token = token
        this.tokenExpiresAt = this.now() + Math.max(30_000, parseTimeoutMs(payload.timeout, this.now()) * 0.8)
      } finally {
        release()
      }
    })().finally(() => { this.loginInFlight = null })
    this.loginInFlight = run
    return run
  }

  async ping(): Promise<void> {
    await this.request('POST', '/ping')
  }

  async logout(): Promise<void> {
    if (!this.token) return
    try {
      await this.send('POST', '/logout', { token: this.token })
    } catch {
      // The session expires on its own.
    } finally {
      this.token = null
    }
  }

  get hasSession(): boolean {
    return this.token != null && this.tokenExpiresAt > this.now()
  }

  // ── transport ────────────────────────────────────────────────────────────

  private async pace(): Promise<void> {
    const turn = this.paceChain.then(async () => {
      const wait = this.lastRequestAt + REQUEST_GAP_MS - this.now()
      if (wait > 0) await this.sleep(wait)
      this.lastRequestAt = this.now()
    })
    this.paceChain = turn.catch(() => undefined)
    await turn
  }

  private async send(
    method: string,
    path: string,
    init: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: unknown; headers: Headers }> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(init.headers ?? {}),
    }
    if (init.token) headers.Authorization = `DXAPI ${init.token}`
    let body: string | undefined
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      throw new DxtradeApiError(timedOut ? 'The DXtrade server did not answer in time' : 'Could not reach the DXtrade server', 0)
    }
    if (response.status >= 300 && response.status < 400) {
      throw new DxtradeApiError('The DXtrade server redirected the request', response.status)
    }
    const text = await response.text().catch(() => '')
    let data: unknown = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    if (!response.ok) {
      const err = asRecord(data)
      const description = String(err.description ?? err.message ?? err.errorMessage ?? '').trim()
      throw new DxtradeApiError(
        description || `DXtrade request failed (${response.status})`,
        response.status,
        err.errorCode == null ? undefined : String(err.errorCode),
      )
    }
    return { status: response.status, data, headers: response.headers }
  }

  /** Authenticated request. Re-logs in once on 401 and once more on 429 for reads. */
  async request(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: unknown; headers: Headers }> {
    if (!this.token || this.tokenExpiresAt <= this.now()) await this.login()
    await this.pace()
    try {
      return await this.send(method, path, { token: this.token ?? undefined, ...init })
    } catch (error) {
      if (error instanceof DxtradeApiError && error.status === 401 && path !== '/login') {
        this.token = null
        await this.login()
        await this.pace()
        return this.send(method, path, { token: this.token ?? undefined, ...init })
      }
      if (error instanceof DxtradeApiError && error.status === 429 && method === 'GET') {
        await this.sleep(1000)
        await this.pace()
        return this.send(method, path, { token: this.token ?? undefined, ...init })
      }
      throw error
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async accounts(): Promise<Array<{ account: string; baseCurrency: string; status: string; isPositionBased: boolean | undefined }>> {
    const user = `${this.credential.username}@${this.credential.domain}`
    const { data } = await this.request('GET', `/users/${encodeURIComponent(user)}`)
    const users = Array.isArray(data) ? rows(data) : rows(data, 'users')
    const candidates = users.length ? users : [asRecord(data)]
    const out = []
    for (const candidate of candidates) {
      for (const account of rows(asRecord(candidate).accounts)) {
        const code = String(account.account ?? '').trim()
        if (!code) continue
        const flag = account.isPositionBased
        out.push({
          account: code,
          baseCurrency: String(account.baseCurrency ?? '').trim() || 'USD',
          status: String(account.accountStatus ?? '').trim().toUpperCase(),
          isPositionBased: typeof flag === 'boolean' ? flag : String(flag ?? '').toLowerCase() === 'true' ? true : String(flag ?? '').toLowerCase() === 'false' ? false : undefined,
        })
      }
    }
    return out
  }

  async metrics(): Promise<Json> {
    const { data } = await this.request('GET', `${this.accountPath}/metrics`)
    return rows(data, 'metrics')[0] ?? asRecord(data)
  }

  async positions(): Promise<Json[]> {
    const { data } = await this.request('GET', `${this.accountPath}/positions`)
    return rows(data, 'positions')
  }

  async openOrders(): Promise<OpenOrdersResult> {
    const { data, headers } = await this.request('GET', `${this.accountPath}/orders`)
    return { orders: rows(data, 'orders'), etag: headers.get('etag') }
  }

  async orderHistory(params: Record<string, string>): Promise<Json[]> {
    const query = new URLSearchParams(params).toString()
    const { data } = await this.request('GET', `${this.accountPath}/orders/history${query ? `?${query}` : ''}`)
    return rows(data, 'orders')
  }

  async instrumentsQuery(symbols?: string): Promise<DxtradeInstrument[]> {
    const path = symbols ? `/instruments/query?symbols=${encodeURIComponent(symbols)}` : '/instruments/query?limit=5000'
    const { data } = await this.request('GET', path)
    return rows(data, 'instruments').map(toInstrument).filter((item): item is DxtradeInstrument => item != null)
  }

  /** Resolve one signal symbol against the broker's list. Tries a targeted query before the full list. */
  async findInstrument(symbol: string, cached?: Map<string, DxtradeInstrument>): Promise<DxtradeInstrument | undefined> {
    if (cached?.size) {
      const hit = matchInstrument(cached.values(), symbol)
      if (hit) return hit
    }
    const direct = await this.instrumentsQuery(symbol).catch(() => [])
    const hit = matchInstrument(direct, symbol)
    if (hit) return hit
    const all = await this.instrumentsQuery()
    if (cached) for (const item of all) cached.set(item.symbol, item)
    return matchInstrument(all, symbol)
  }

  async quote(symbol: string): Promise<{ symbol: string; bid: number; ask: number; time?: string }> {
    const { data } = await this.request('POST', '/marketdata', {
      body: { account: this.credential.accountCode, symbols: [symbol], eventTypes: [{ type: 'Quote', format: 'COMPACT' }] },
    })
    const events = rows(data, 'events')
    const quote = events.find(event => String(event.type ?? 'Quote') === 'Quote' && String(event.symbol ?? symbol) === symbol) ?? events[0]
    const bid = finite(quote?.bid)
    const ask = finite(quote?.ask)
    if (!bid || !ask) throw new DxtradeApiError(`DXtrade quote for ${symbol} is unavailable`, 404)
    return { symbol, bid, ask, time: quote?.time == null ? undefined : String(quote.time) }
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** Place a single order or an order group. Returns the order responses (a group returns several). */
  async placeOrder(body: unknown): Promise<Array<{ orderId: number | undefined; updateOrderId: number | undefined }>> {
    const { data } = await this.request('POST', `${this.accountPath}/orders`, { body })
    const list = Array.isArray(data) ? rows(data) : rows(data, 'orderResponses', 'orders')
    const responses = list.length ? list : [asRecord(data)]
    return responses.map(item => ({ orderId: finite(item.orderId), updateOrderId: finite(item.updateOrderId) }))
  }

  /** Replace an order. DXtrade requires the whole request and an `If-Match` ETag. */
  async modifyOrder(body: unknown, etag: string | null): Promise<void> {
    await this.request('PUT', `${this.accountPath}/orders`, {
      body,
      headers: etag ? { 'If-Match': etag } : undefined,
    })
  }

  async cancelOrder(orderCode: string, etag: string | null): Promise<void> {
    await this.request('DELETE', `${this.accountPath}/orders/${encodeURIComponent(orderCode)}`, {
      headers: etag ? { 'If-Match': etag } : undefined,
    })
  }
}

export function toInstrument(row: Json): DxtradeInstrument | null {
  const symbol = String(row.symbol ?? '').trim()
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
