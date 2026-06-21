import WebSocket from 'ws'
import { normalizeFxsocketWsMessage } from './fxsocketStreamNormalize'

const DEFAULT_BASE_URL = 'https://api.fxsocket.com'

export type FxsocketWsTopic = 'prices' | 'bars' | 'account' | 'positions' | 'trades' | 'terminal'

export interface FxsocketWsSubscribeFrame {
  action: 'subscribe' | 'unsubscribe'
  topic: FxsocketWsTopic
  symbol?: string
  timeframe?: string
}

export type FxsocketWsServerMessage =
  | { type: 'tick'; symbol: string; data: Record<string, unknown> }
  | { type: 'bar'; symbol: string; timeframe: string; data: Record<string, unknown> }
  | { type: 'account'; data: Record<string, unknown> }
  | { type: 'positions'; data: unknown[] }
  | { type: 'trade'; data: Record<string, unknown> }
  | { type: 'terminal'; data: Record<string, unknown> }
  | { type: 'subscribed' | 'unsubscribed' | 'error' | 'warning'; [key: string]: unknown }

export type FxsocketWsMessageHandler = (msg: FxsocketWsServerMessage) => void

export interface FxsocketWsClientOptions {
  accountId: string
  apiKey: string
  baseUrl?: string
  platform?: 'MT4' | 'MT5'
  reconnect?: boolean
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
  onConnectionChange?: (connected: boolean) => void
}

function trimEnv(v: string | undefined): string {
  return (v ?? '').trim()
}

function wsBaseUrl(httpBase: string): string {
  const u = httpBase.replace(/\/+$/, '')
  if (u.startsWith('https://')) return `wss://${u.slice('https://'.length)}`
  if (u.startsWith('http://')) return `ws://${u.slice('http://'.length)}`
  return `wss://${u}`
}

function subscriptionKey(frame: FxsocketWsSubscribeFrame): string {
  const parts = [frame.action === 'subscribe' ? 'sub' : 'unsub', frame.topic]
  if (frame.symbol) parts.push(frame.symbol)
  if (frame.timeframe) parts.push(frame.timeframe)
  return parts.join(':')
}

export class FxsocketWsClient {
  private readonly accountId: string
  private readonly apiKey: string
  private readonly wsUrl: string
  private readonly reconnect: boolean
  private readonly reconnectDelayMs: number
  private readonly maxReconnectDelayMs: number
  private readonly onConnectionChange?: (connected: boolean) => void

  private ws: WebSocket | null = null
  private handlers = new Set<FxsocketWsMessageHandler>()
  private activeSubscriptions = new Map<string, FxsocketWsSubscribeFrame>()
  private intentionalClose = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0

  constructor(opts: FxsocketWsClientOptions) {
    const base = trimEnv(opts.baseUrl) || trimEnv(process.env.FXSOCKET_BASE_URL) || DEFAULT_BASE_URL
    const id = String(opts.accountId ?? '').trim()
    const key = String(opts.apiKey ?? '').trim()
    if (!id) throw new Error('FxsocketWsClient: accountId required')
    if (!key) throw new Error('FxsocketWsClient: apiKey required')

    this.accountId = id
    this.apiKey = key
    const segment = opts.platform === 'MT4' ? 'mt4' : 'mt5'
    this.wsUrl = `${wsBaseUrl(base)}/${segment}/${encodeURIComponent(id)}/ws?api_key=${encodeURIComponent(key)}`
    this.reconnect = opts.reconnect !== false
    this.reconnectDelayMs = Math.max(500, opts.reconnectDelayMs ?? 2_000)
    this.maxReconnectDelayMs = Math.max(this.reconnectDelayMs, opts.maxReconnectDelayMs ?? 60_000)
    this.onConnectionChange = opts.onConnectionChange
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  onMessage(handler: FxsocketWsMessageHandler): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.intentionalClose = false
    this.clearReconnectTimer()

    const ws = new WebSocket(this.wsUrl, {
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
    })
    this.ws = ws

    ws.on('open', () => {
      this.reconnectAttempt = 0
      this.onConnectionChange?.(true)
      for (const frame of this.activeSubscriptions.values()) {
        this.sendFrame(frame)
      }
    })

    ws.on('message', (data) => {
      const msg = this.parseMessage(data)
      if (!msg) return
      for (const handler of this.handlers) {
        try { handler(msg) } catch (e) {
          console.warn('[fxsocketWsClient] handler error:', e instanceof Error ? e.message : e)
        }
      }
    })

    ws.on('close', () => {
      this.onConnectionChange?.(false)
      if (!this.intentionalClose && this.reconnect && this.handlers.size > 0) {
        this.scheduleReconnect()
      }
    })

    ws.on('error', (err) => {
      console.warn(`[fxsocketWsClient] socket error account=${this.accountId}:`, err.message)
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

  subscribe(frame: Omit<FxsocketWsSubscribeFrame, 'action'>): void {
    const full: FxsocketWsSubscribeFrame = { action: 'subscribe', ...frame }
    this.activeSubscriptions.set(subscriptionKey(full), full)
    this.connect()
    this.sendFrame(full)
  }

  unsubscribe(frame: Omit<FxsocketWsSubscribeFrame, 'action'>): void {
    const full: FxsocketWsSubscribeFrame = { action: 'unsubscribe', ...frame }
    const key = subscriptionKey({ action: 'subscribe', topic: frame.topic, symbol: frame.symbol, timeframe: frame.timeframe })
    this.activeSubscriptions.delete(key)
    this.sendFrame(full)
    if (this.handlers.size === 0 && this.activeSubscriptions.size === 0) {
      this.close()
    }
  }

  private sendFrame(frame: FxsocketWsSubscribeFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch (e) {
      console.warn('[fxsocketWsClient] send failed:', e instanceof Error ? e.message : e)
    }
  }

  private parseMessage(data: WebSocket.RawData): FxsocketWsServerMessage | null {
    const text = typeof data === 'string' ? data : data.toString('utf8')
    if (!text.trim()) return null
    try {
      const parsed = JSON.parse(text) as unknown
      return normalizeFxsocketWsMessage(parsed)
    } catch {
      console.warn('[fxsocketWsClient] invalid JSON frame:', text.slice(0, 200))
    }
    return null
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

export function buildFxsocketWsUrl(
  accountId: string,
  apiKey: string,
  baseUrl?: string,
  platform: 'MT4' | 'MT5' = 'MT5',
): string {
  const base = trimEnv(baseUrl) || trimEnv(process.env.FXSOCKET_BASE_URL) || DEFAULT_BASE_URL
  const segment = platform === 'MT4' ? 'mt4' : 'mt5'
  return `${wsBaseUrl(base)}/${segment}/${encodeURIComponent(accountId)}/ws?api_key=${encodeURIComponent(apiKey)}`
}
