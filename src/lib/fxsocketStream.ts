import { ensureFreshAuthSession, fxsocketBroker } from './fxsocketBroker'
import { normalizeFxsocketStreamMessage } from './fxsocketStreamNormalize'
import type { FxsocketStreamMessage, FxsocketStreamSubscribeFrame, FxsocketStreamTopic } from './fxsocketStreamTypes'

export type { FxsocketStreamMessage, FxsocketStreamSubscribeFrame, FxsocketStreamTopic } from './fxsocketStreamTypes'

const LIVE_BROKER_TOPICS: FxsocketStreamTopic[] = ['account', 'positions', 'trades']

export interface FxsocketStreamHandle {
  close(): void
  subscribe(frame: FxsocketStreamSubscribeFrame): void
  unsubscribe(frame: Omit<FxsocketStreamSubscribeFrame, 'action'>): void
}

function workerStreamUrlFromBase(brokerAccountId: string, token: string, base: string): string {
  const httpBase = base.startsWith('http') ? base : `https://${base}`
  const u = new URL(httpBase.replace(/\/+$/, ''))
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/broker/stream'
  u.search = new URLSearchParams({
    broker_account_id: brokerAccountId,
    token,
  }).toString()
  return u.toString()
}

async function resolveBrokerStreamUrl(brokerAccountId: string, token: string): Promise<string> {
  try {
    const { ws_url } = await fxsocketBroker.streamTicket(brokerAccountId)
    const u = new URL(ws_url)
    u.searchParams.set('token', token)
    return u.toString()
  } catch {
    const raw = String(import.meta.env.VITE_WORKER_URL ?? '').trim()
    if (!raw) throw new Error('VITE_WORKER_URL is not configured and stream_ticket failed')
    return workerStreamUrlFromBase(brokerAccountId, token, raw)
  }
}

export async function openFxsocketStream(
  brokerAccountId: string,
  handlers: {
    onMessage?: (msg: FxsocketStreamMessage) => void
    onStateChange?: (connected: boolean) => void
    onError?: (message: string) => void
  },
): Promise<FxsocketStreamHandle> {
  let ws: WebSocket | null = null
  let closed = false
  let connecting = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  const notifyState = (connected: boolean) => handlers.onStateChange?.(connected)

  const sendFrame = (frame: Record<string, unknown>) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(frame))
  }

  const subscribeLiveTopics = () => {
    for (const topic of LIVE_BROKER_TOPICS) {
      sendFrame({ action: 'subscribe', topic })
    }
  }

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return
    const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  const connect = async () => {
    if (closed || connecting) return
    connecting = true
    try {
      const token = await ensureFreshAuthSession()
      const url = await resolveBrokerStreamUrl(brokerAccountId, token)
      try { ws?.close() } catch { /* ignore */ }
      const socket = new WebSocket(url)
      ws = socket

      socket.onopen = () => {
        connecting = false
        reconnectAttempt = 0
        notifyState(true)
        subscribeLiveTopics()
      }
      socket.onmessage = (event) => {
        try {
          const msg = normalizeFxsocketStreamMessage(JSON.parse(String(event.data)))
          if (msg) handlers.onMessage?.(msg)
        } catch {
          /* ignore malformed frames */
        }
      }
      socket.onerror = () => {
        handlers.onError?.('Live broker stream connection error')
      }
      socket.onclose = () => {
        connecting = false
        if (ws === socket) ws = null
        notifyState(false)
        if (!closed) scheduleReconnect()
      }
    } catch (err) {
      connecting = false
      handlers.onError?.(err instanceof Error ? err.message : 'Live broker stream setup failed')
      if (!closed) scheduleReconnect()
    }
  }

  void connect()

  return {
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { ws?.close() } catch { /* ignore */ }
      ws = null
    },
    subscribe(frame) {
      sendFrame({ ...frame, action: 'subscribe' })
    },
    unsubscribe(frame) {
      sendFrame({ ...frame, action: 'unsubscribe' })
    },
  }
}
