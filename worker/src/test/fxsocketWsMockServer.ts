import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

export type FxsocketMockWsServer = {
  httpBaseUrl: string
  port: number
  close: () => Promise<void>
}

export type FxsocketMockWsServerOptions = {
  /** When false, server ignores ping frames (client should detect timeout). */
  respondToPing?: boolean
  /** Terminate connection when client sends a WebSocket ping. */
  closeOnPing?: boolean
  port?: number
}

/**
 * In-process FxSocket WebSocket mock.
 * Path shape: /mt4|mt5/{accountId}/ws?api_key=...
 */
export async function startFxsocketMockWsServer(
  opts: FxsocketMockWsServerOptions = {},
): Promise<FxsocketMockWsServer> {
  const respondToPing = opts.respondToPing !== false
  const server: Server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (!/^\/mt[45]\/[^/]+\/ws$/i.test(path)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'terminal', data: { connected: true } }))

    ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>
        const action = String(frame.action ?? '')
        if (action === 'subscribe' || action === 'unsubscribe') {
          ws.send(JSON.stringify({
            type: action === 'subscribe' ? 'subscribed' : 'unsubscribed',
            topic: frame.topic,
            symbol: frame.symbol,
          }))
        }
      } catch {
        /* ignore */
      }
    })

    if (opts.closeOnPing) {
      ws.on('ping', () => {
        try { ws.terminate() } catch { /* ignore */ }
      })
    } else if (!respondToPing) {
      ws.on('ping', () => {
        /* drop ping — no pong */
      })
    }
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('mock ws server failed to bind'))
        return
      }
      resolve(addr.port)
    })
  })

  return {
    httpBaseUrl: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve, reject) => {
      for (const client of wss.clients) {
        try { client.close() } catch { /* ignore */ }
      }
      wss.close(err => {
        if (err) reject(err)
        else server.close(e => (e ? reject(e) : resolve()))
      })
    }),
  }
}
