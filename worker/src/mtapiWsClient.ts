import WebSocket from 'ws'

const DEFAULT_BASE_URL = 'https://mtapi.tscopier.ai:9443'

/** Update types that should wake social/mirror copy reconcile. */
export const MTAPI_COPY_RELEVANT_UPDATE_TYPES = new Set([
  'marketopen',
  'marketclose',
  'partialclose',
  'marketmodify',
  'pendingopen',
  'pendingclose',
  'pendingmodify',
  'filled',
  'onstoploss',
  'ontakeprofit',
  'onstopout',
  'marketcloseby',
  'started',
  'cancelling',
  'expired',
  'rejected',
  // Numeric proto enums (UpdateType_*)
  '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '15', '16', '17',
])

export type MtapiOrderUpdateEvent = {
  raw: unknown
  updateType: string | null
  copyRelevant: boolean
}

export type MtapiOrderUpdateHandler = (event: MtapiOrderUpdateEvent) => void

export type MtapiWsClientOptions = {
  sessionId: string
  platform?: 'MT4' | 'MT5' | string | null
  baseUrl?: string
  /** Bearer token for nginx Authorization (defaults to MTAPI_API_KEY / MTAPI_PROXY_KEY). */
  apiKey?: string
  /** Shared secret for X-Internal-Token (defaults to MTAPI_INTERNAL_TOKEN). */
  internalToken?: string
  reconnect?: boolean
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
  onConnectionChange?: (connected: boolean) => void
  WebSocketImpl?: typeof WebSocket
}

/** Headers required by the self-hosted MTAPI nginx front door. */
export function mtapiWsAuthHeaders(opts?: { apiKey?: string; internalToken?: string }): Record<string, string> {
  const headers: Record<string, string> = {}
  const proxyKey = trimEnv(opts?.apiKey) || trimEnv(process.env.MTAPI_PROXY_KEY) || trimEnv(process.env.MTAPI_API_KEY)
  if (proxyKey) headers.Authorization = `Bearer ${proxyKey}`
  const internalToken = trimEnv(opts?.internalToken) || trimEnv(process.env.MTAPI_INTERNAL_TOKEN)
  if (internalToken) headers['X-Internal-Token'] = internalToken
  return headers
}

function trimEnv(v: string | undefined): string {
  return (v ?? '').trim()
}

export function mtapiHttpBaseUrl(platform?: string | null, override?: string): string {
  const explicit = trimEnv(override)
  if (explicit) return explicit.replace(/\/+$/, '')
  const normalized = String(platform ?? '').trim().toUpperCase()
  const specific = trimEnv(
    normalized === 'MT4' ? process.env.MTAPI_MT4_BASE_URL : process.env.MTAPI_MT5_BASE_URL,
  )
  const fallback = trimEnv(process.env.MTAPI_BASE_URL) || DEFAULT_BASE_URL
  return (specific || fallback).replace(/\/+$/, '')
}

export function mtapiWsBaseUrl(httpBase: string): string {
  const u = httpBase.replace(/\/+$/, '')
  if (u.startsWith('https://')) return `wss://${u.slice('https://'.length)}`
  if (u.startsWith('http://')) return `ws://${u.slice('http://'.length)}`
  if (u.startsWith('wss://') || u.startsWith('ws://')) return u
  return `wss://${u}`
}

export function buildMtapiOnOrderUpdateUrl(
  sessionId: string,
  platform?: string | null,
  baseUrl?: string,
): string {
  const id = String(sessionId ?? '').trim()
  if (!id) throw new Error('MtapiWsClient: sessionId required')
  const base = mtapiWsBaseUrl(mtapiHttpBaseUrl(platform, baseUrl))
  return `${base}/OnOrderUpdate?id=${encodeURIComponent(id)}`
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value == null) return
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectStrings(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>
    for (const key of ['type', 'Type', 'updateType', 'UpdateType', 'action', 'Action']) {
      if (key in row) collectStrings(row[key], out, depth + 1)
    }
    if (row.update != null) collectStrings(row.update, out, depth + 1)
    if (row.Update != null) collectStrings(row.Update, out, depth + 1)
    if (row.data != null) collectStrings(row.data, out, depth + 1)
    if (row.result != null) collectStrings(row.result, out, depth + 1)
  }
}

/** Normalize MTAPI OnOrderUpdate payloads into a copy-relevance decision. */
export function normalizeMtapiOrderUpdate(raw: unknown): MtapiOrderUpdateEvent {
  const candidates: string[] = []
  collectStrings(raw, candidates)
  let updateType: string | null = null
  let copyRelevant = false
  for (const candidate of candidates) {
    const normalized = candidate.trim().toLowerCase().replace(/^updatetype[_]?/, '')
    if (!normalized) continue
    if (!updateType) updateType = normalized
    if (MTAPI_COPY_RELEVANT_UPDATE_TYPES.has(normalized)) {
      updateType = normalized
      copyRelevant = true
      break
    }
  }
  // Some bridges emit a bare opened-orders snapshot without an explicit type.
  // Treat non-empty object payloads as potentially relevant so we still wake.
  if (!copyRelevant && raw && typeof raw === 'object') {
    const row = raw as Record<string, unknown>
    const hasOrders = Array.isArray(row.openedOrders)
      || Array.isArray(row.OpenedOrders)
      || Array.isArray((row.data as Record<string, unknown> | undefined)?.openedOrders)
      || Array.isArray((row.data as Record<string, unknown> | undefined)?.OpenedOrders)
      || Array.isArray((row.result as Record<string, unknown> | undefined)?.openedOrders)
      || Array.isArray((row.result as Record<string, unknown> | undefined)?.OpenedOrders)
    if (hasOrders) copyRelevant = true
  }
  return { raw, updateType, copyRelevant }
}

export class MtapiWsClient {
  private readonly sessionId: string
  private readonly wsUrl: string
  private readonly authHeaders: Record<string, string>
  private readonly reconnect: boolean
  private readonly reconnectDelayMs: number
  private readonly maxReconnectDelayMs: number
  private readonly onConnectionChange?: (connected: boolean) => void
  private readonly WebSocketImpl: typeof WebSocket

  private ws: WebSocket | null = null
  private handlers = new Set<MtapiOrderUpdateHandler>()
  private intentionalClose = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0

  constructor(opts: MtapiWsClientOptions) {
    const id = String(opts.sessionId ?? '').trim()
    if (!id) throw new Error('MtapiWsClient: sessionId required')
    this.sessionId = id
    this.wsUrl = buildMtapiOnOrderUpdateUrl(id, opts.platform, opts.baseUrl)
    this.authHeaders = mtapiWsAuthHeaders(opts)
    this.reconnect = opts.reconnect !== false
    this.reconnectDelayMs = Math.max(500, opts.reconnectDelayMs ?? 2_000)
    this.maxReconnectDelayMs = Math.max(this.reconnectDelayMs, opts.maxReconnectDelayMs ?? 60_000)
    this.onConnectionChange = opts.onConnectionChange
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket
  }

  get connected(): boolean {
    return this.ws?.readyState === this.WebSocketImpl.OPEN
  }

  get url(): string {
    return this.wsUrl
  }

  onMessage(handler: MtapiOrderUpdateHandler): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === this.WebSocketImpl.OPEN || this.ws.readyState === this.WebSocketImpl.CONNECTING)) {
      return
    }
    this.intentionalClose = false
    this.clearReconnectTimer()

    const ws = new this.WebSocketImpl(this.wsUrl, {
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
      headers: this.authHeaders,
    })
    this.ws = ws

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.reconnectAttempt = 0
      this.onConnectionChange?.(true)
    })

    ws.on('message', (data) => {
      if (this.ws !== ws) return
      const event = this.parseMessage(data)
      if (!event) return
      for (const handler of this.handlers) {
        try { handler(event) } catch (error) {
          console.warn('[mtapiWsClient] handler error:', error instanceof Error ? error.message : error)
        }
      }
    })

    ws.on('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      this.onConnectionChange?.(false)
      if (!this.intentionalClose && this.reconnect && this.handlers.size > 0) {
        this.scheduleReconnect()
      }
    })

    ws.on('error', (err) => {
      if (this.ws !== ws) return
      console.warn(`[mtapiWsClient] socket error session=${this.sessionId.slice(0, 8)}:`, err.message)
    })
  }

  close(): void {
    this.intentionalClose = true
    this.clearReconnectTimer()
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
  }

  private parseMessage(data: WebSocket.RawData): MtapiOrderUpdateEvent | null {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    if (!text.trim()) return null
    try {
      return normalizeMtapiOrderUpdate(JSON.parse(text) as unknown)
    } catch {
      console.warn('[mtapiWsClient] invalid JSON frame:', text.slice(0, 200))
      return null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.min(
      this.maxReconnectDelayMs,
      this.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempt),
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.intentionalClose) this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
