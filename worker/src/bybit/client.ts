/**
 * Bybit V5 REST client (linear derivatives).
 *
 * Signed requests send `X-BAPI-API-KEY`, `X-BAPI-TIMESTAMP`, `X-BAPI-RECV-WINDOW` and
 * `X-BAPI-SIGN`, an HMAC-SHA256 hex digest of
 * `timestamp + apiKey + recvWindow + (queryString | exact JSON body)`.
 * Replies are HTTP 200 with `{ retCode, retMsg, result }`; zero is success.
 * Reference: https://bybit-exchange.github.io/docs/v5/guide
 *
 * Bybit answers 403 to US and mainland China IP addresses, so the worker region matters.
 */
import { createHmac } from 'node:crypto'

export type BybitEnvironment = 'demo' | 'live'

export const BYBIT_HOSTS: Record<BybitEnvironment, string> = {
  live: 'https://api.bybit.com',
  demo: 'https://api-demo.bybit.com',
}

export interface BybitCredential {
  accountId: string
  environment: BybitEnvironment
  apiKey: string
  apiSecret: string
  /** Quote-currency margin committed to each copied signal. */
  marginUsdt: number
  leverage: number
}

/** `retCode` for "The request time exceeds the time window range". */
export const BYBIT_TIMESTAMP_CODE = 10002

export class BybitApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly status: number,
  ) {
    super(message)
    this.name = 'BybitApiError'
  }
}

export type Params = Record<string, string | number | boolean | undefined | null>

export function buildQuery(params: Params): string {
  const pairs: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return pairs.join('&')
}

/** JSON body with undefined and null fields removed. The same string is signed and sent. */
export function buildBody(params: Params): string {
  const clean: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    clean[key] = value
  }
  return JSON.stringify(clean)
}

/** `timestamp + apiKey + recvWindow + payload`, signed as lowercase hex. */
export function signPayload(
  secret: string,
  timestamp: string | number,
  apiKey: string,
  recvWindow: string | number,
  payload: string,
): string {
  return createHmac('sha256', secret).update(`${timestamp}${apiKey}${recvWindow}${payload}`).digest('hex')
}

export function bybitErrorMessage(body: unknown, status: number): string {
  if (status === 403) {
    return 'Bybit blocked this server (HTTP 403). Bybit does not serve US or mainland China IP addresses, so the worker region must change.'
  }
  if (body && typeof body === 'object') {
    const msg = (body as Record<string, unknown>).retMsg
    if (typeof msg === 'string' && msg.trim()) return msg.trim()
  }
  return `Bybit HTTP ${status}`
}

export interface BybitClientOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  recvWindowMs?: number
}

export class BybitClient {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly recvWindow: number
  private clockOffsetMs: number | null = null

  constructor(
    private readonly credential: Pick<BybitCredential, 'apiKey' | 'apiSecret' | 'environment'>,
    options: BybitClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.recvWindow = options.recvWindowMs ?? 10_000
  }

  get baseUrl(): string {
    return BYBIT_HOSTS[this.credential.environment]
  }

  async publicGet<T = Record<string, unknown>>(path: string, params: Params = {}): Promise<T> {
    return this.send<T>('GET', path, params, false)
  }

  async signed<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, params: Params = {}): Promise<T> {
    try {
      return await this.send<T>(method, path, params, true)
    } catch (error) {
      // 10002: our clock is outside recvWindow. Re-read server time once and retry.
      if (error instanceof BybitApiError && error.code === BYBIT_TIMESTAMP_CODE) {
        this.clockOffsetMs = null
        return this.send<T>(method, path, params, true)
      }
      throw error
    }
  }

  private async timestamp(): Promise<number> {
    if (this.clockOffsetMs == null) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/v5/market/time`, { method: 'GET' })
        const body = await response.json() as { time?: number }
        this.clockOffsetMs = typeof body.time === 'number' ? body.time - this.now() : 0
      } catch {
        this.clockOffsetMs = 0
      }
    }
    return this.now() + this.clockOffsetMs
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Params,
    signed: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {}
    let url = `${this.baseUrl}${path}`
    let payload: string | undefined
    if (method === 'GET') {
      const query = buildQuery(params)
      if (query) url += `?${query}`
      payload = query
    } else {
      payload = buildBody(params)
      headers['Content-Type'] = 'application/json'
    }
    if (signed) {
      const timestamp = String(await this.timestamp())
      headers['X-BAPI-API-KEY'] = this.credential.apiKey
      headers['X-BAPI-TIMESTAMP'] = timestamp
      headers['X-BAPI-RECV-WINDOW'] = String(this.recvWindow)
      headers['X-BAPI-SIGN'] = signPayload(this.credential.apiSecret, timestamp, this.credential.apiKey, this.recvWindow, payload)
    }
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: method === 'POST' ? payload : undefined,
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!response.ok) throw new BybitApiError(bybitErrorMessage(body, response.status), null, response.status)
    const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : null
    if (!envelope) throw new BybitApiError('Bybit returned an unreadable response', null, response.status)
    const code = Number(envelope.retCode)
    if (code !== 0) {
      throw new BybitApiError(bybitErrorMessage(envelope, response.status), Number.isFinite(code) ? code : null, response.status)
    }
    return (envelope.result ?? {}) as T
  }
}
