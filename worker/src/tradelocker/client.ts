/**
 * TradeLocker REST client (one per linked account).
 *
 * Spec: https://public-api.tradelocker.com (v2.11.0). Hosts are fixed per environment, so a stored
 * login can never point the worker at an arbitrary URL. Auth is a JWT pair from
 * `POST /auth/jwt/token {email, password, server}`; every `/trade/*` call carries the `accNum` header.
 * List endpoints return rows as arrays, and `GET /trade/config` names the columns.
 *
 * Reads are paced because GET orders, positions and ordersHistory allow about one request per second.
 * A 401 triggers one refresh (or re-login). Writes are never retried blindly: a timeout or 5xx on a
 * write surfaces as an "uncertain" error so the caller can reconcile by `strategyId`.
 * A 429 is different: TradeLocker refused the request before acting on it, so reads and writes alike
 * are retried a few times after a back-off, and the whole client pauses while the limit clears.
 */
import type { TradelockerInstrument, TradelockerInstrumentDetails } from './symbols'

export type TradelockerEnvironment = 'demo' | 'live'

export const TRADELOCKER_HOSTS: Record<TradelockerEnvironment, string> = {
  demo: 'https://demo.tradelocker.com/backend-api',
  live: 'https://live.tradelocker.com/backend-api',
}

export interface TradelockerCredential {
  /** Worker account key (the stored fingerprint). */
  accountId: string
  environment: TradelockerEnvironment
  server: string
  email: string
  password: string
  /** TradeLocker account id and the `accNum` header value. */
  tlAccountId: string
  accNum: number
}

export class TradelockerApiError extends Error {
  status: number
  /** From the `Retry-After` header of a 429, when TradeLocker sent one. */
  retryAfterMs?: number
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message)
    this.name = 'TradelockerApiError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
  /** True when the server may have processed the request (no answer, or a 5xx). */
  get uncertain(): boolean {
    return this.status === 0 || this.status >= 500
  }
}

export type Json = Record<string, unknown>

export interface TradelockerClientOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  requestTimeoutMs?: number
  /** TradeLocker Developer API key, sent as a header when set. */
  developerKey?: string
}

const USER_AGENT = 'TScopier/1.0 (+https://tscopier.ai)'
const DEFAULT_TIMEOUT_MS = 15_000
const LIST_GAP_MS = 1100
const REQUEST_GAP_MS = 150
const LOGIN_GAP_MS = 700
/** Rate-limited (429) requests are retried this many times before the error is surfaced. */
const RATE_LIMIT_RETRIES = 3
const RATE_LIMIT_BACKOFF_MS = 1000
const RATE_LIMIT_MAX_WAIT_MS = 8000
const CONFIG_TTL_MS = 30 * 60_000
const INSTRUMENT_TTL_MS = 10 * 60_000

// Logins are limited, so every client in this process shares one gate.
let lastLoginAt = 0
let loginGate: Promise<void> = Promise.resolve()

export function resetTradelockerLoginGateForTests(): void {
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

/** `Retry-After` is either whole seconds or an HTTP date. */
function parseRetryAfterMs(value: string | null, now: number): number | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export function friendlyTradelockerError(error: unknown): string {
  if (error instanceof TradelockerApiError) {
    if (error.status === 401) return 'TradeLocker rejected the stored email, password or server name'
    if (error.status === 403) return 'TradeLocker refused the request. Check that this account may trade through the API'
    if (error.status === 429) return 'TradeLocker is rate limiting requests'
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

function rowsToObjects(columns: string[], list: unknown): Json[] {
  if (!Array.isArray(list)) return []
  return list.map(row => {
    if (Array.isArray(row)) {
      const out: Json = {}
      columns.forEach((column, index) => {
        if (column) out[column] = row[index]
      })
      return out
    }
    return asRecord(row)
  })
}

function columnsOf(config: Json, name: string): string[] {
  const panel = asRecord(config[name])
  return (Array.isArray(panel.columns) ? panel.columns : []).map(column => String(asRecord(column).id ?? ''))
}

interface Session {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export class TradelockerClient {
  private session: Session | null = null
  private loginInFlight: Promise<void> | null = null
  private paceChain: Promise<void> = Promise.resolve()
  /** After a 429 no request leaves this client before this time. */
  private cooldownUntil = 0
  private readonly lastAt = new Map<string, number>()
  private configCache: { at: number; config: Json } | null = null
  private instrumentCache: { at: number; list: TradelockerInstrument[] } | null = null
  private readonly detailsCache = new Map<number, { at: number; details: TradelockerInstrumentDetails }>()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly timeoutMs: number
  private readonly developerKey: string
  readonly host: string

  constructor(readonly credential: TradelockerCredential, options: TradelockerClientOptions = {}) {
    const host = TRADELOCKER_HOSTS[credential.environment]
    if (!host) throw new Error('TradeLocker environment must be demo or live')
    this.host = host
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.developerKey = String(options.developerKey ?? process.env.TRADELOCKER_DEVELOPER_API_KEY ?? '').trim()
  }

  private get accountPath(): string {
    return `/trade/accounts/${encodeURIComponent(this.credential.tlAccountId)}`
  }

  get hasSession(): boolean {
    return this.session != null && this.session.expiresAt > this.now()
  }

  // ── session ──────────────────────────────────────────────────────────────

  private parseSession(data: unknown): Session {
    const payload = asRecord(asRecord(data).d ?? data)
    const accessToken = String(payload.accessToken ?? '').trim()
    if (!accessToken) throw new TradelockerApiError('TradeLocker did not return a session', 0)
    const expires = Date.parse(String(payload.expireDate ?? ''))
    return {
      accessToken,
      refreshToken: String(payload.refreshToken ?? '').trim(),
      expiresAt: Number.isFinite(expires) ? expires - 60_000 : this.now() + 30 * 60_000,
    }
  }

  async login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight
    const run = (async () => {
      const previous = loginGate
      let release!: () => void
      loginGate = new Promise<void>(resolve => { release = resolve })
      try {
        await previous
        const wait = lastLoginAt + LOGIN_GAP_MS - this.now()
        if (wait > 0) await this.sleep(wait)
        lastLoginAt = this.now()
        const data = await this.send('POST', '/auth/jwt/token', {
          body: { email: this.credential.email, password: this.credential.password, server: this.credential.server },
        })
        this.session = this.parseSession(data)
      } finally {
        release()
      }
    })().finally(() => { this.loginInFlight = null })
    this.loginInFlight = run
    return run
  }

  private async refresh(): Promise<void> {
    const refreshToken = this.session?.refreshToken
    if (!refreshToken) return this.login()
    try {
      const data = await this.send('POST', '/auth/jwt/refresh', { body: { refreshToken } })
      this.session = this.parseSession(data)
    } catch {
      this.session = null
      await this.login()
    }
  }

  async logout(): Promise<void> {
    this.session = null
  }

  async ping(): Promise<void> {
    await this.accounts()
  }

  // ── transport ────────────────────────────────────────────────────────────

  private async pace(key: string, gap: number): Promise<void> {
    const turn = this.paceChain.then(async () => {
      const wait = Math.max((this.lastAt.get(key) ?? 0) + gap, this.cooldownUntil) - this.now()
      if (wait > 0) await this.sleep(wait)
      this.lastAt.set(key, this.now())
    })
    this.paceChain = turn.catch(() => undefined)
    await turn
  }

  private async send(
    method: string,
    path: string,
    init: { token?: string; accNum?: boolean; body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<unknown> {
    const url = new URL(`${this.host}${path}`)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    }
    if (this.developerKey) {
      headers['developer-api-key'] = this.developerKey
      headers['tl-developer-api-key'] = this.developerKey
    }
    if (init.token) headers.Authorization = `Bearer ${init.token}`
    if (init.accNum) headers.accNum = String(this.credential.accNum)
    let body: string | undefined
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      throw new TradelockerApiError(timedOut ? 'TradeLocker did not answer in time' : 'Could not reach TradeLocker', 0)
    }
    if (response.status >= 300 && response.status < 400) {
      throw new TradelockerApiError('TradeLocker redirected the request', response.status)
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
    const payload = asRecord(data)
    if (!response.ok || payload.s === 'error') {
      const message = String(payload.errmsg ?? payload.message ?? payload.error ?? payload.description ?? '').trim()
      const status = response.ok ? 400 : response.status
      const fallback = status === 429
        ? 'TradeLocker is rate limiting requests (429)'
        : `TradeLocker request failed (${status})`
      throw new TradelockerApiError(message || fallback, status, status === 429 ? parseRetryAfterMs(response.headers.get('retry-after'), this.now()) : undefined)
    }
    return data
  }

  /** Authenticated request. Refreshes once on 401, and retries a rate-limited read once. */
  async request(
    method: string,
    path: string,
    init: { body?: unknown; query?: Record<string, string | number | undefined>; accNum?: boolean } = {},
  ): Promise<unknown> {
    if (!this.session) await this.login()
    else if (this.session.expiresAt <= this.now()) await this.refresh()
    const withAccNum = init.accNum !== false
    const gap = method === 'GET' && /\/(orders|positions|ordersHistory)$/.test(path) ? LIST_GAP_MS : REQUEST_GAP_MS
    const key = `${method} ${path.replace(/\/[^/]*\d[^/]*/g, '/#')}`
    const run = async (): Promise<unknown> => {
      await this.pace(key, gap)
      return this.send(method, path, { ...init, accNum: withAccNum, token: this.session?.accessToken })
    }
    let reloggedIn = false
    for (let rateLimited = 0; ;) {
      try {
        return await run()
      } catch (error) {
        if (error instanceof TradelockerApiError) {
          if (error.status === 401 && !reloggedIn) {
            reloggedIn = true
            this.session = null
            await this.login()
            continue
          }
          // A 429 means the request was refused unprocessed, so repeating it (even an order) cannot duplicate it.
          if (error.status === 429 && rateLimited < RATE_LIMIT_RETRIES) {
            const backoff = error.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS * 2 ** rateLimited
            this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.max(backoff, 500)))
            rateLimited += 1
            continue
          }
        }
        throw error
      }
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async config(): Promise<Json> {
    if (this.configCache && this.now() - this.configCache.at < CONFIG_TTL_MS) return this.configCache.config
    const data = await this.request('GET', '/trade/config')
    const config = asRecord(asRecord(data).d)
    this.configCache = { at: this.now(), config }
    return config
  }

  async accounts(): Promise<Array<{ accountId: string; accNum: number; currency: string; status: string; balance: number | undefined }>> {
    const data = await this.request('GET', '/auth/jwt/all-accounts', { accNum: false })
    const payload = asRecord(data)
    const list = Array.isArray(payload.accounts) ? payload.accounts : asRecord(payload.d).accounts
    const out = []
    for (const item of Array.isArray(list) ? list : []) {
      const account = asRecord(item)
      const accountId = String(account.id ?? '').trim()
      const accNum = finite(account.accNum)
      if (!accountId || accNum === undefined) continue
      out.push({
        accountId,
        accNum,
        currency: String(account.currency ?? '').trim() || 'USD',
        status: String(account.status ?? '').trim().toUpperCase(),
        balance: finite(account.accountBalance ?? account.balance),
      })
    }
    return out
  }

  async accountState(): Promise<Json> {
    const config = await this.config()
    const data = await this.request('GET', `${this.accountPath}/state`)
    const values = asRecord(asRecord(data).d).accountDetailsData
    return rowsToObjects(columnsOf(config, 'accountDetailsConfig'), [Array.isArray(values) ? values : []])[0] ?? {}
  }

  async instruments(): Promise<TradelockerInstrument[]> {
    if (this.instrumentCache && this.now() - this.instrumentCache.at < INSTRUMENT_TTL_MS) return this.instrumentCache.list
    const data = await this.request('GET', `${this.accountPath}/instruments`)
    const list: TradelockerInstrument[] = []
    const instruments = asRecord(asRecord(data).d).instruments
    for (const item of Array.isArray(instruments) ? instruments : []) {
      const row = asRecord(item)
      const id = finite(row.tradableInstrumentId)
      const name = String(row.name ?? '').trim()
      if (id === undefined || !name) continue
      const routes = Array.isArray(row.routes) ? row.routes.map(asRecord) : []
      list.push({
        tradableInstrumentId: id,
        name,
        tradeRouteId: finite(routes.find(route => String(route.type).toUpperCase() === 'TRADE')?.id),
        infoRouteId: finite(routes.find(route => String(route.type).toUpperCase() === 'INFO')?.id),
      })
    }
    // Keep the previous list when a refresh comes back empty.
    if (list.length === 0 && this.instrumentCache) return this.instrumentCache.list
    this.instrumentCache = { at: this.now(), list }
    return list
  }

  async instrumentDetails(instrument: TradelockerInstrument): Promise<TradelockerInstrumentDetails> {
    const hit = this.detailsCache.get(instrument.tradableInstrumentId)
    if (hit && this.now() - hit.at < INSTRUMENT_TTL_MS) return hit.details
    const data = await this.request('GET', `/trade/instruments/${instrument.tradableInstrumentId}`, {
      query: { routeId: instrument.tradeRouteId },
    })
    const row = asRecord(asRecord(data).d)
    const positive = (value: unknown) => {
      const n = finite(value)
      return n != null && n > 0 ? n : undefined
    }
    const quoting = row.quotingCurrency ?? row.quoteCurrency ?? row.quotingCurrencyName
    const details: TradelockerInstrumentDetails = {
      lotSize: positive(row.lotSize ?? row.contractSize),
      lotStep: positive(row.lotStep ?? row.qtyStep ?? row.quantityStep),
      minLot: positive(row.minLot ?? row.lotMin ?? row.minQty),
      maxLot: positive(row.maxLot ?? row.lotMax ?? row.maxQty),
      tickSize: positive(row.tickSize ?? row.priceStep ?? row.pipSize),
      quotingCurrency: typeof quoting === 'string' && quoting.trim() ? quoting.trim().toUpperCase() : undefined,
    }
    this.detailsCache.set(instrument.tradableInstrumentId, { at: this.now(), details })
    return details
  }

  async positions(): Promise<Json[]> {
    const config = await this.config()
    const data = await this.request('GET', `${this.accountPath}/positions`)
    return rowsToObjects(columnsOf(config, 'positionsConfig'), asRecord(asRecord(data).d).positions)
  }

  async orders(): Promise<Json[]> {
    const config = await this.config()
    const data = await this.request('GET', `${this.accountPath}/orders`)
    return rowsToObjects(columnsOf(config, 'ordersConfig'), asRecord(asRecord(data).d).orders)
  }

  async ordersHistory(from?: number, to?: number): Promise<Json[]> {
    const config = await this.config()
    const data = await this.request('GET', `${this.accountPath}/ordersHistory`, { query: { from, to } })
    return rowsToObjects(columnsOf(config, 'ordersHistoryConfig'), asRecord(asRecord(data).d).ordersHistory)
  }

  async quote(instrument: TradelockerInstrument): Promise<{ symbol: string; bid: number; ask: number }> {
    if (instrument.infoRouteId === undefined) throw new TradelockerApiError(`No quote route for ${instrument.name}`, 404)
    const data = await this.request('GET', '/trade/quotes', {
      query: { routeId: instrument.infoRouteId, tradableInstrumentId: instrument.tradableInstrumentId },
    })
    const quote = asRecord(asRecord(data).d)
    const bid = finite(quote.bp)
    const ask = finite(quote.ap)
    if (!bid || !ask) throw new TradelockerApiError(`TradeLocker quote for ${instrument.name} is unavailable`, 404)
    return { symbol: instrument.name, bid, ask }
  }

  // ── writes ───────────────────────────────────────────────────────────────

  async placeOrder(body: Json): Promise<string> {
    const data = await this.request('POST', `${this.accountPath}/orders`, { body })
    const orderId = String(asRecord(asRecord(data).d).orderId ?? '').trim()
    if (!orderId) throw new TradelockerApiError('TradeLocker did not return an order id', 0)
    return orderId
  }

  async modifyPosition(positionId: string, body: Json): Promise<void> {
    await this.request('PATCH', `/trade/positions/${encodeURIComponent(positionId)}`, { body })
  }

  async modifyOrder(orderId: string, body: Json): Promise<void> {
    await this.request('PATCH', `/trade/orders/${encodeURIComponent(orderId)}`, { body })
  }

  /** `qty` of 0 closes the whole position. */
  async closePosition(positionId: string, qty: number): Promise<void> {
    await this.request('DELETE', `/trade/positions/${encodeURIComponent(positionId)}`, { body: { qty } })
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request('DELETE', `/trade/orders/${encodeURIComponent(orderId)}`)
  }
}
