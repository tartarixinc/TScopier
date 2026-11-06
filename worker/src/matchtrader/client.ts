/**
 * Match-Trader Platform API client (one per linked account).
 *
 * Docs: https://app.theneo.io/match-trade/platform-api (limit 500 requests/minute).
 * Every broker hosts its own platform URL, so the stored URL is re-validated (public https host, DNS
 * not private) before any request. Auth: `POST /manager/mtr-login` returns a 15 minute `token` (sent as
 * `Cookie: co-auth=...`) and a per-account `tradingApiToken` (header `Auth-trading-api`).
 * `/manager/refresh-token` renews it from the login cookies; a 401 refreshes or logs in once more.
 *
 * Writes are never retried blindly: a timeout or 5xx on a write surfaces as an "uncertain" error so the
 * caller can reconcile against the positions list (Match-Trader has no client order id).
 */
import { asRecordOf, MatchtraderApiError } from './errors'
import { finite, type MatchtraderInstrument } from './symbols'
import { assertPublicMatchtraderHost, normalizeMatchtraderUrl, type HostResolver } from './urlSafety'

export { MatchtraderApiError } from './errors'
export type Json = Record<string, unknown>

export interface MatchtraderCredential {
  /** Worker account key (the stored fingerprint). */
  accountId: string
  /** broker_accounts.id, used for the comment tag table. */
  brokerAccountId: string
  serverUrl: string
  brokerId: string
  email: string
  password: string
  tradingAccountUuid: string
  systemUuid: string
}

export interface MatchtraderClientOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  requestTimeoutMs?: number
  /** Overrides the DNS check (tests). */
  resolveHost?: HostResolver
}

const USER_AGENT = 'TScopier/1.0 (+https://tscopier.ai)'
const DEFAULT_TIMEOUT_MS = 15_000
const LOGIN_GAP_MS = 700
const SESSION_TTL_MS = 13 * 60_000
const INSTRUMENT_TTL_MS = 10 * 60_000

// Logins are shared by every client in this process, so they are spaced out.
let lastLoginAt = 0
let loginGate: Promise<void> = Promise.resolve()

export function resetMatchtraderLoginGateForTests(): void {
  lastLoginAt = 0
  loginGate = Promise.resolve()
}

export function friendlyMatchtraderError(error: unknown): string {
  if (error instanceof MatchtraderApiError) {
    if (error.code === 'TFA') return 'Match-Trader two-factor sign-in is enabled for this login'
    if (error.status === 401) return 'Match-Trader rejected the stored email, password or broker'
    if (error.status === 403) return 'Match-Trader refused the request. Check that this account may trade through the API'
    if (error.status === 429) return 'Match-Trader is rate limiting requests'
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

interface Session {
  jar: Map<string, string>
  tradingApiToken: string
  systemUuid: string
  expiresAt: number
  altToken: string
  usedAlt: boolean
}

function setCookiesOf(headers: Headers): string[] {
  const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getter === 'function') return getter.call(headers)
  const single = headers.get('set-cookie')
  return single ? [single] : []
}

function absorbCookies(jar: Map<string, string>, lines: string[]): void {
  for (const line of lines) {
    const pair = line.split(';')[0] ?? ''
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!name) continue
    if (!value) jar.delete(name)
    else jar.set(name, value)
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

interface AccountLogin {
  uuid: string
  systemUuid: string
  tradingApiToken: string
  accountToken: string
}

export class MatchtraderClient {
  private session: Session | null = null
  private loginInFlight: Promise<void> | null = null
  private instrumentCache: { at: number; list: MatchtraderInstrument[] } | null = null
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly timeoutMs: number
  private readonly resolveHost: HostResolver | undefined
  readonly serverUrl: string

  constructor(readonly credential: MatchtraderCredential, options: MatchtraderClientOptions = {}) {
    const normalized = normalizeMatchtraderUrl(credential.serverUrl)
    if (!normalized.ok) throw new Error(normalized.error)
    this.serverUrl = normalized.url
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.resolveHost = options.resolveHost
  }

  get hasSession(): boolean {
    return this.session != null && this.session.expiresAt > this.now()
  }

  // ── transport ────────────────────────────────────────────────────────────

  private async send(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<{ data: unknown; setCookies: string[] }> {
    const url = new URL(`${this.serverUrl}${path}`)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(init.headers ?? {}),
    }
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
      throw new MatchtraderApiError(timedOut ? 'Match-Trader did not answer in time' : 'Could not reach Match-Trader', 0)
    }
    if (response.status >= 300 && response.status < 400) {
      throw new MatchtraderApiError('Match-Trader redirected the request', response.status)
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
      const payload = asRecordOf(data)
      const message = String(payload.errorMessage ?? payload.detail ?? payload.message ?? payload.title ?? payload.error ?? '').trim()
      throw new MatchtraderApiError(message || `Match-Trader request failed (${response.status})`, response.status)
    }
    return { data, setCookies: setCookiesOf(response.headers) }
  }

  // ── session ──────────────────────────────────────────────────────────────

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
        try {
          await assertPublicMatchtraderHost(this.serverUrl, this.resolveHost)
        } catch (error) {
          throw new MatchtraderApiError(error instanceof Error ? error.message : 'Match-Trader host check failed', 400)
        }
        const { data, setCookies } = await this.send('POST', '/manager/mtr-login', {
          body: { email: this.credential.email, password: this.credential.password, brokerId: this.credential.brokerId },
        })
        this.session = this.sessionFrom(data, setCookies)
      } finally {
        release()
      }
    })().finally(() => { this.loginInFlight = null })
    this.loginInFlight = run
    return run
  }

  private sessionFrom(data: unknown, setCookies: string[]): Session {
    const payload = asRecordOf(data)
    if (asRecordOf(payload.tfaConfig).isEnabledForSignIn === true) {
      throw new MatchtraderApiError('Match-Trader two-factor sign-in is enabled for this login', 403, 'TFA')
    }
    const list = Array.isArray(payload.tradingAccounts) ? payload.tradingAccounts : Array.isArray(payload.accounts) ? payload.accounts : []
    const accounts: AccountLogin[] = list.map(item => {
      const row = asRecordOf(item)
      return {
        uuid: String(row.uuid ?? '').trim(),
        systemUuid: String(asRecordOf(asRecordOf(row.offer).system).uuid ?? '').trim(),
        tradingApiToken: String(row.tradingApiToken ?? '').trim(),
        accountToken: String(asRecordOf(row.tradingAccountToken).token ?? '').trim(),
      }
    })
    const mine = accounts.find(item => item.uuid === this.credential.tradingAccountUuid)
    if (!mine) throw new MatchtraderApiError('This Match-Trader account is no longer available on the login', 404)
    const jar = new Map<string, string>()
    absorbCookies(jar, setCookies)
    const base = String(payload.token ?? '').trim()
    if (base && !jar.has('co-auth')) jar.set('co-auth', base)
    const selected = String(asRecordOf(payload.selectedTradingAccount).uuid ?? '').trim()
    // The login token covers the selected account. Another account may need its own account token.
    const current = jar.get('co-auth') ?? ''
    let altToken = ''
    if (mine.accountToken && mine.accountToken !== current) {
      if (selected && mine.uuid !== selected) {
        jar.set('co-auth', mine.accountToken)
        altToken = current
      } else {
        altToken = mine.accountToken
      }
    }
    return {
      jar,
      tradingApiToken: mine.tradingApiToken,
      systemUuid: mine.systemUuid || this.credential.systemUuid,
      expiresAt: this.now() + SESSION_TTL_MS,
      altToken,
      usedAlt: false,
    }
  }

  private async refresh(): Promise<void> {
    const session = this.session
    if (!session) return this.login()
    try {
      const { data, setCookies } = await this.send('POST', '/manager/refresh-token', {
        headers: { Cookie: cookieHeader(session.jar) },
      })
      const jar = new Map(session.jar)
      absorbCookies(jar, setCookies)
      const token = String(asRecordOf(data).token ?? '').trim()
      if (token) jar.set('co-auth', token)
      if (setCookies.length === 0 && !token) {
        this.session = null
        return this.login()
      }
      this.session = { ...session, jar, expiresAt: this.now() + SESSION_TTL_MS }
    } catch {
      this.session = null
      await this.login()
    }
  }

  async logout(): Promise<void> {
    this.session = null
  }

  async ping(): Promise<void> {
    await this.balance()
  }

  /** Authenticated request under `/mtr-api/{systemUuid}`. Refreshes once on 401, retries a rate-limited read once. */
  async request(
    method: string,
    path: string,
    init: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<unknown> {
    if (!this.session) await this.login()
    else if (this.session.expiresAt <= this.now()) await this.refresh()
    const run = async (): Promise<unknown> => {
      const session = this.session!
      const route = `/mtr-api/${encodeURIComponent(session.systemUuid)}${path}`
      const { data } = await this.send(method, route, {
        ...init,
        headers: { 'Auth-trading-api': session.tradingApiToken, Cookie: cookieHeader(session.jar) },
      })
      return data
    }
    try {
      return await run()
    } catch (error) {
      if (error instanceof MatchtraderApiError && error.status === 401) {
        this.session = null
        await this.login()
        try {
          return await run()
        } catch (retry) {
          const session = this.session as Session | null
          if (retry instanceof MatchtraderApiError && retry.status === 401 && session && session.altToken && !session.usedAlt) {
            session.jar.set('co-auth', session.altToken)
            session.usedAlt = true
            return run()
          }
          throw retry
        }
      }
      if (error instanceof MatchtraderApiError && error.status === 429 && method === 'GET') {
        await this.sleep(1200)
        return run()
      }
      throw error
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async balance(): Promise<Json> {
    return asRecordOf(await this.request('GET', '/balance'))
  }

  async instruments(): Promise<MatchtraderInstrument[]> {
    if (this.instrumentCache && this.now() - this.instrumentCache.at < INSTRUMENT_TTL_MS) return this.instrumentCache.list
    const data = await this.request('GET', '/effective-instruments')
    const source = Array.isArray(data) ? data : Array.isArray(asRecordOf(data).instruments) ? asRecordOf(data).instruments as unknown[] : []
    const list: MatchtraderInstrument[] = []
    for (const item of source) {
      const row = asRecordOf(item)
      const symbol = String(row.symbol ?? '').trim()
      if (!symbol) continue
      const quote = String(row.quoteCurrency ?? '').trim().toUpperCase()
      list.push({
        symbol,
        alias: String(row.alias ?? '').trim(),
        volumeMin: finite(row.volumeMin),
        volumeMax: finite(row.volumeMax),
        volumeStep: finite(row.volumeStep),
        volumePrecision: finite(row.volumePrecision),
        contractSize: finite(row.contractSize),
        pricePrecision: finite(row.pricePrecision),
        sizeOfOnePoint: finite(row.sizeOfOnePoint),
        quoteCurrency: quote || undefined,
      })
    }
    // Keep the previous list when a refresh comes back empty.
    if (list.length === 0 && this.instrumentCache) return this.instrumentCache.list
    this.instrumentCache = { at: this.now(), list }
    return list
  }

  async positions(): Promise<Json[]> {
    const data = asRecordOf(await this.request('GET', '/open-positions'))
    return (Array.isArray(data.positions) ? data.positions : []).map(asRecordOf)
  }

  async activeOrders(): Promise<Json[]> {
    const data = asRecordOf(await this.request('GET', '/active-orders'))
    return (Array.isArray(data.orders) ? data.orders : []).map(asRecordOf)
  }

  /** Closed positions in a range. Partial closes are separate rows that share the position id. */
  async closedPositions(fromMs: number, toMs: number): Promise<Json[]> {
    const data = asRecordOf(await this.request('POST', '/closed-positions', {
      body: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    }))
    return (Array.isArray(data.operations) ? data.operations : []).map(asRecordOf)
  }

  async quote(instrument: MatchtraderInstrument): Promise<{ symbol: string; bid: number; ask: number }> {
    const data = await this.request('GET', '/quotations', { query: { symbols: instrument.symbol } })
    const rows = Array.isArray(data) ? data : Object.values(asRecordOf(data))
    for (const item of rows) {
      const row = asRecordOf(item)
      const bid = finite(row.bid)
      const ask = finite(row.ask)
      if (bid && ask) return { symbol: instrument.symbol, bid, ask }
    }
    throw new MatchtraderApiError(`Match-Trader quote for ${instrument.symbol} is unavailable`, 404)
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** A write answers `{ status, errorMessage, orderId }`; a status other than OK is a rejection. */
  private async write(path: string, body: Json): Promise<{ orderId: string }> {
    const data = asRecordOf(await this.request('POST', path, { body }))
    const status = String(data.status ?? '').trim()
    const message = String(data.errorMessage ?? '').trim()
    if ((status && status.toUpperCase() !== 'OK') || (!status && message)) {
      throw new MatchtraderApiError(message || `Match-Trader rejected the request (${status || 'no status'})`, 400)
    }
    return { orderId: String(data.orderId ?? '').trim() }
  }

  async openPosition(body: Json): Promise<string> {
    const { orderId } = await this.write('/position/open', body)
    if (!orderId) throw new MatchtraderApiError('Match-Trader did not return an order id', 0)
    return orderId
  }

  async editPosition(body: Json): Promise<void> {
    await this.write('/position/edit', body)
  }

  async closePosition(body: Json): Promise<void> {
    await this.write('/position/close', body)
  }

  async closePartially(body: Json): Promise<void> {
    await this.write('/position/close-partially', body)
  }

  async createPending(body: Json): Promise<string> {
    const { orderId } = await this.write('/pending-order/create', body)
    if (!orderId) throw new MatchtraderApiError('Match-Trader did not return an order id', 0)
    return orderId
  }

  async editPending(body: Json): Promise<void> {
    await this.write('/pending-order/edit', body)
  }

  async cancelPending(body: Json): Promise<void> {
    await this.write('/pending-order/cancel', body)
  }
}
