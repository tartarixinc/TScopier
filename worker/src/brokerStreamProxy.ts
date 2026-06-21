import type { Server } from 'http'
import type { IncomingMessage } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { SupabaseClient } from '@supabase/supabase-js'
import { brokerSessionId } from './mtApiByAccount'
import { mtPlatformFrom } from './fxsocketClient'
import type { FxsocketStreamManager } from './fxsocketStreamManager'
import type { FxsocketWsServerMessage } from './fxsocketWsClient'

const DEFAULT_SUBSCRIPTIONS = [
  { topic: 'account' as const },
  { topic: 'positions' as const },
  { topic: 'trades' as const },
  { topic: 'terminal' as const },
]

function parseUrlQuery(url: string): URLSearchParams {
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  return new URLSearchParams(q)
}

async function verifyUserToken(
  supabase: SupabaseClient,
  token: string,
): Promise<string | null> {
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user?.id) return null
  return data.user.id
}

async function loadOwnedBroker(
  supabase: SupabaseClient,
  userId: string,
  brokerAccountId: string,
): Promise<{ fxsocket_account_id: string; metaapi_account_id?: string | null; platform?: string | null } | null> {
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('fxsocket_account_id,metaapi_account_id,platform')
    .eq('id', brokerAccountId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return null
  const sessionId = brokerSessionId(data)
  if (!sessionId) return null
  return data as { fxsocket_account_id: string; metaapi_account_id?: string | null }
}

/**
 * JWT-gated WebSocket proxy: browser → worker → FxSocket upstream.
 * Path: GET /broker/stream?broker_account_id=…&token=… (or Authorization: Bearer)
 */
export function attachBrokerStreamProxy(
  server: Server,
  supabase: SupabaseClient,
  streamManager: FxsocketStreamManager,
): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (path !== '/broker/stream') return

    void (async () => {
      try {
        const params = parseUrlQuery(req.url ?? '')
        const brokerAccountId = params.get('broker_account_id')?.trim() ?? ''
        const token =
          params.get('token')?.trim()
          ?? req.headers.authorization?.replace(/^Bearer\s+/i, '').trim()
          ?? ''
        if (!brokerAccountId || !token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }

        const userId = await verifyUserToken(supabase, token)
        if (!userId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }

        const broker = await loadOwnedBroker(supabase, userId, brokerAccountId)
        if (!broker) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }

        const sessionId = brokerSessionId(broker)
        const platform = mtPlatformFrom(broker.platform)
        wss.handleUpgrade(req, socket, head, (clientWs) => {
          void handleClientConnection(clientWs, sessionId, streamManager, platform)
        })
      } catch (err) {
        console.warn('[brokerStreamProxy] upgrade failed:', err instanceof Error ? err.message : err)
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
        socket.destroy()
      }
    })()
  })
}

function handleClientConnection(
  clientWs: WebSocket,
  sessionId: string,
  streamManager: FxsocketStreamManager,
  platform: 'MT4' | 'MT5',
): void {
  const relay = (msg: FxsocketWsServerMessage) => {
    if (clientWs.readyState !== WebSocket.OPEN) return
    try {
      clientWs.send(JSON.stringify(msg))
    } catch {
      /* ignore */
    }
  }

  const unsub = streamManager.subscribe(sessionId, relay, DEFAULT_SUBSCRIPTIONS, platform)

  clientWs.on('message', (raw) => {
    try {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>
      const action = String(frame.action ?? '')
      if (action === 'subscribe' || action === 'unsubscribe') {
        const topic = String(frame.topic ?? '') as 'prices' | 'bars' | 'account' | 'positions' | 'trades' | 'terminal'
        const sub = {
          topic,
          symbol: frame.symbol != null ? String(frame.symbol) : undefined,
          timeframe: frame.timeframe != null ? String(frame.timeframe) : undefined,
        }
        if (action === 'subscribe') {
          streamManager.ensureTopic(sessionId, sub)
        }
      }
    } catch {
      /* ignore malformed client frames */
    }
  })

  clientWs.on('close', () => {
    unsub()
  })

  clientWs.on('error', () => {
    unsub()
  })
}
