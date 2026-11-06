/**
 * KuCoin Futures REST client (classic account, https://api-futures.kucoin.com).
 *
 * Private requests send `KC-API-KEY`, `KC-API-SIGN`, `KC-API-TIMESTAMP`, `KC-API-PASSPHRASE`
 * and `KC-API-KEY-VERSION`.
 *   sign       = base64(HMAC-SHA256(secret, timestamp + METHOD + path[?query] + body))
 *   passphrase = base64(HMAC-SHA256(secret, passphrase))
 * Replies are `{ code, data }`; `code` "200000" is success. Errors keep the same shape with
 * `msg` and may use a non-200 HTTP status.
 * Reference: https://www.kucoin.com/docs-new/authentication
 */
import { createHmac } from 'node:crypto'

export const KUCOIN_FUTURES_HOST = 'https://api-futures.kucoin.com'

export type KucoinMarginMode = 'isolated' | 'cross'

export interface KucoinCredential {
  accountId: string
  apiKey: string
  apiSecret: string
  passphrase: string
  /** Margin committed to each copied signal. Position notional is margin times leverage. */
  marginUsdt: number
  leverage: number
  marginMode: KucoinMarginMode
}

/** `400002`: timestamp differs from server time by more than 5 seconds. */
export const KUCOIN_TIMESTAMP_CODE = 400002
/** Passphrase or signature rejected. Tried again with the older key version. */
const KEY_VERSION_CODES = new Set([400004, 400005])
const KEY_VERSIONS = ['3', '2'] as const

export class KucoinApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly status: number,
  ) {
    super(message)
    this.name = 'KucoinApiError'
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

/** JSON body with undefined, null and empty fields removed. The same string is signed and sent. */
export function buildBody(params: Params): string {
  const clean: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    clean[key] = value
  }
  return JSON.stringify(clean)
}

/** `timestamp + METHOD + requestPath + body`, signed as base64. The path keeps its raw query string. */
export function signRequest(secret: string, timestamp: string | number, method: string, requestPath: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${method.toUpperCase()}${requestPath}${body}`).digest('base64')
}

export function signPassphrase(secret: string, passphrase: string): string {
  return createHmac('sha256', secret).update(passphrase).digest('base64')
}

export function kucoinErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const code = Number(record.code)
    if (code === 40010) {
      return 'KuCoin restricts this account or server region from trading (40010). Check the account region and the worker region.'
    }
    if (code === 400006) {
      return "KuCoin rejected this server's IP address. Add it to the API key's IP whitelist or remove the restriction."
    }
    if (code === 400007) {
      return 'This KuCoin API key lacks permission. Enable General and Futures permissions.'
    }
    if (code === 400003) return 'KuCoin does not know this API key. Check the key.'
    if (code === 400004) return 'KuCoin rejected the API passphrase. Check the passphrase set when the key was created.'
    if (code === 400005) return 'KuCoin rejected the request signature. Check the API secret.'
    const msg = record.msg
    if (typeof msg === 'string' && msg.trim()) return msg.trim()
  }
  if (status === 403) return 'KuCoin blocked this server (HTTP 403). Check the worker region and IP whitelist.'
  return `KuCoin HTTP ${status}`
}

export interface KucoinClientOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  host?: string
}

export class KucoinClient {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly host: string
  private clockOffsetMs: number | null = null
  private keyVersion: string = KEY_VERSIONS[0]
  private versionConfirmed = false

  constructor(
    private readonly credential: Pick<KucoinCredential, 'apiKey' | 'apiSecret' | 'passphrase'>,
    options: KucoinClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.host = options.host ?? KUCOIN_FUTURES_HOST
  }

  async publicGet<T = unknown>(path: string, params: Params = {}): Promise<T> {
    return this.send<T>('GET', path, params, false)
  }

  async signed<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}): Promise<T> {
    let timestampRetried = false
    let versionIndex = KEY_VERSIONS.indexOf(this.keyVersion as typeof KEY_VERSIONS[number])
    for (;;) {
      try {
        const data = await this.send<T>(method, path, params, true)
        this.versionConfirmed = true
        return data
      } catch (error) {
        if (error instanceof KucoinApiError && error.code === KUCOIN_TIMESTAMP_CODE && !timestampRetried) {
          // Our clock is outside the 5 second window. Re-read server time once.
          timestampRetried = true
          this.clockOffsetMs = null
          continue
        }
        if (
          error instanceof KucoinApiError
          && error.code != null
          && KEY_VERSION_CODES.has(error.code)
          && !this.versionConfirmed
          && versionIndex < KEY_VERSIONS.length - 1
        ) {
          // Nothing was accepted yet, so retrying with the other key version cannot double-submit.
          versionIndex += 1
          this.keyVersion = KEY_VERSIONS[versionIndex]!
          continue
        }
        throw error
      }
    }
  }

  private async timestamp(): Promise<number> {
    if (this.clockOffsetMs == null) {
      try {
        const response = await this.fetchImpl(`${this.host}/api/v1/timestamp`, { method: 'GET' })
        const body = await response.json() as { data?: number }
        this.clockOffsetMs = typeof body.data === 'number' ? body.data - this.now() : 0
      } catch {
        this.clockOffsetMs = 0
      }
    }
    return this.now() + this.clockOffsetMs
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Params,
    signed: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    let requestPath = path
    let body = ''
    if (method === 'POST') {
      body = buildBody(params)
    } else {
      const query = buildQuery(params)
      if (query) requestPath += `?${query}`
    }
    if (signed) {
      const timestamp = String(await this.timestamp())
      headers['KC-API-KEY'] = this.credential.apiKey
      headers['KC-API-SIGN'] = signRequest(this.credential.apiSecret, timestamp, method, requestPath, body)
      headers['KC-API-TIMESTAMP'] = timestamp
      headers['KC-API-PASSPHRASE'] = signPassphrase(this.credential.apiSecret, this.credential.passphrase)
      headers['KC-API-KEY-VERSION'] = this.keyVersion
    }
    const response = await this.fetchImpl(`${this.host}${requestPath}`, {
      method,
      headers,
      body: method === 'POST' ? body : undefined,
    })
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    const envelope = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    if (!envelope) {
      throw new KucoinApiError(
        response.ok ? 'KuCoin returned an unreadable response' : kucoinErrorMessage(null, response.status),
        null,
        response.status,
      )
    }
    const code = Number(envelope.code)
    if (code !== 200000) {
      throw new KucoinApiError(
        kucoinErrorMessage(envelope, response.status),
        Number.isFinite(code) ? code : null,
        response.status,
      )
    }
    return envelope.data as T
  }
}
