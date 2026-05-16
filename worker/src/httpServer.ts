import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { AuthService } from './authService'
import { UserSessionManager } from './sessionManager'

const INTERNAL_TOKEN = process.env.WORKER_INTERNAL_TOKEN ?? ''
const PORT = parseInt(process.env.WORKER_PORT ?? '8080', 10)

interface Body {
  user_id?: string
  phone?: string
  code?: string
  password?: string
  channel_row_id?: string
  days?: number
  from?: string
  to?: string
  // legacy fields ignored — the worker holds state across calls now
  phone_code_hash?: string
  session_string?: string
}

/**
 * Authenticated HTTP API consumed only by the supabase telegram-auth
 * edge function. Authenticates with a static internal token so requests
 * cannot originate from the public internet without the secret.
 *
 * Endpoints:
 *  POST /auth/send_code     { user_id, phone }
 *  POST /auth/verify_code   { user_id, phone, code, password? }
 *  POST /auth/list_channels { user_id }
 *  POST /auth/backfill_channel_history { user_id, channel_row_id, days? }
 *  POST /auth/import_backtest_history { user_id, channel_row_id, from, to }
 */
export function startHttpServer(
  authService: AuthService,
  sessionManager: UserSessionManager,
): Server {
  if (!INTERNAL_TOKEN) {
    throw new Error('WORKER_INTERNAL_TOKEN must be set in env')
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') {
        return sendJson(res, 404, { error: 'Not found' })
      }

      const token = req.headers['x-internal-token']
      if (token !== INTERNAL_TOKEN) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }

      const body = (await readJson(req)) as Body
      const url = req.url ?? ''

      if (url === '/auth/send_code') {
        if (!body.user_id || !body.phone) {
          return sendJson(res, 400, { error: 'user_id and phone are required' })
        }
        const r = await authService.sendCode(body.user_id, body.phone)
        return sendJson(res, 200, r)
      }

      if (url === '/auth/verify_code') {
        if (!body.user_id || !body.phone || !body.code) {
          return sendJson(res, 400, { error: 'user_id, phone, and code are required' })
        }
        try {
          const r = await authService.verifyCode(body.user_id, body.phone, body.code, body.password)
          if ('requires_password' in r) {
            return sendJson(res, 400, {
              error: 'Two-step verification required',
              requires_password: true,
            })
          }
          return sendJson(res, 200, r)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Verification failed'
          return sendJson(res, 400, { error: msg })
        }
      }

      if (url === '/auth/list_channels') {
        if (!body.user_id) {
          return sendJson(res, 400, { error: 'user_id is required' })
        }
        try {
          const channels = await sessionManager.listChannels(body.user_id)
          return sendJson(res, 200, { channels })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to list channels'
          return sendJson(res, 400, { error: msg })
        }
      }

      if (url === '/auth/backfill_channel_history') {
        if (!body.user_id || !body.channel_row_id) {
          return sendJson(res, 400, { error: 'user_id and channel_row_id are required' })
        }
        try {
          const result = await sessionManager.backfillChannelHistory(
            body.user_id,
            body.channel_row_id,
            Number(body.days ?? 30),
          )
          return sendJson(res, 200, result)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to backfill channel history'
          return sendJson(res, 400, { error: msg })
        }
      }

      if (url === '/auth/import_backtest_history') {
        if (!body.user_id || !body.channel_row_id || !body.from || !body.to) {
          return sendJson(res, 400, { error: 'user_id, channel_row_id, from, and to are required' })
        }
        try {
          const result = await sessionManager.importBacktestChannelHistory(
            body.user_id,
            body.channel_row_id,
            body.from,
            body.to,
          )
          return sendJson(res, 200, result)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to import backtest history'
          return sendJson(res, 400, { error: msg })
        }
      }

      if (url === '/health') {
        const status = sessionManager.getStatus()
        // A listener is "healthy" if it's connected and either has not
        // received any event yet (just started) or saw something within
        // the last 5 minutes. Most signal channels post several times an
        // hour, so 5 min of silence on a previously-active listener is a
        // reliable stall signal.
        const now = Date.now()
        const STALE_MS = 5 * 60 * 1000
        const ok = status.every(s =>
          s.connected && (s.last_event_at === 0 || now - s.last_event_at < STALE_MS)
        )
        return sendJson(res, ok ? 200 : 503, {
          ok,
          listeners: status.length,
          detail: status,
          checked_at: new Date(now).toISOString(),
        })
      }

      return sendJson(res, 404, { error: 'Unknown route' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Internal error'
      console.error('[httpServer] error:', msg)
      return sendJson(res, 500, { error: msg })
    }
  })

  server.listen(PORT, () => {
    console.log(`[httpServer] listening on :${PORT}`)
  })

  return server
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
