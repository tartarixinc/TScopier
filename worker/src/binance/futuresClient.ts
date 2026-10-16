/**
 * Binance USD-M futures REST client.
 *
 * Signed requests send the API key in `X-MBX-APIKEY` and an HMAC-SHA256
 * signature of the exact query string. Reference:
 * https://developers.binance.com/docs/derivatives/usds-margined-futures
 */
import { createHmac } from 'node:crypto'

export type BinanceEnvironment = 'demo' | 'live'

export const BINANCE_FUTURES_HOSTS: Record<BinanceEnvironment, string> = {
  live: 'https://fapi.binance.com',
  demo: 'https://demo-fapi.binance.com',
}

export interface BinanceFuturesCredential {
  accountId: string
  environment: BinanceEnvironment
  apiKey: string
  apiSecret: string
  /** USDT margin committed to each copied signal. */
  marginUsdt: number
  leverage: number
  marginMode: 'isolated' | 'cross'
}

export class BinanceApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly status: number,
  ) {
    super(message)
    this.name = 'BinanceApiError'
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

export function signQuery(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex')
}

export function binanceErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const row = body as Record<string, unknown>
    const msg = typeof row.msg === 'string' ? row.msg.trim() : ''
    if (msg) return msg
  }
  return `Binance HTTP ${status}`
}

export interface BinanceClientOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  recvWindowMs?: number
}

export class BinanceFuturesClient {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly recvWindow: number
  private clockOffsetMs: number | null = null

  constructor(
    private readonly credential: Pick<BinanceFuturesCredential, 'apiKey' | 'apiSecret' | 'environment'>,
    options: BinanceClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.recvWindow = options.recvWindowMs ?? 10_000
  }

  get baseUrl(): string {
    return BINANCE_FUTURES_HOSTS[this.credential.environment]
  }

  async publicGet<T = unknown>(path: string, params: Params = {}): Promise<T> {
    return this.send<T>('GET', path, params, false)
  }

  async signed<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params: Params = {}): Promise<T> {
    try {
      return await this.send<T>(method, path, params, true)
    } catch (error) {
      // -1021: our clock is outside recvWindow. Re-read server time once and retry.
      if (error instanceof BinanceApiError && error.code === -1021) {
        this.clockOffsetMs = null
        return this.send<T>(method, path, params, true)
      }
      throw error
    }
  }

  private async serverTimestamp(): Promise<number> {
    if (this.clockOffsetMs == null) {
      try {
        const body = await this.send<{ serverTime?: number }>('GET', '/fapi/v1/time', {}, false)
        this.clockOffsetMs = typeof body.serverTime === 'number' ? body.serverTime - this.now() : 0
      } catch {
        this.clockOffsetMs = 0
      }
    }
    return this.now() + this.clockOffsetMs
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Params,
    signed: boolean,
  ): Promise<T> {
    const all: Params = { ...params }
    if (signed) {
      all.recvWindow = this.recvWindow
      all.timestamp = await this.serverTimestamp()
    }
    let query = buildQuery(all)
    if (signed) query = `${query}&signature=${signQuery(query, this.credential.apiSecret)}`
    const headers: Record<string, string> = {}
    if (signed) headers['X-MBX-APIKEY'] = this.credential.apiKey
    // Binance accepts the signed payload as a query string on every method.
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`
    const response = await this.fetchImpl(url, { method, headers })
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!response.ok) {
      const code = body && typeof body === 'object' && typeof (body as Record<string, unknown>).code === 'number'
        ? (body as { code: number }).code
        : null
      throw new BinanceApiError(binanceErrorMessage(body, response.status), code, response.status)
    }
    return body as T
  }
}
