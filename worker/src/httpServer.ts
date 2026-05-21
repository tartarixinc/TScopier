import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { AuthService } from './authService'
import { TelegramSessionInvalidError, TELEGRAM_SESSION_INVALID_CODE } from './telegramClient'
import type { SignalRow, TradeExecutor } from './tradeExecutor'
import { UserSessionManager } from './sessionManager'
import { userBelongsToShard } from './workerConfig'
import { getQueueHealthMetrics } from './queue/queueHealth'

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
  run_id?: string
  phone_code_hash?: string
  session_string?: string
}

function isTelegramSessionInvalid(err: unknown): err is TelegramSessionInvalidError {
  return err instanceof TelegramSessionInvalidError
}

async function handleTelegramRpcError(
  res: ServerResponse,
  userId: string | undefined,
  sessionManager: UserSessionManager,
  err: unknown,
  fallbackMessage: string,
): Promise<void> {
  if (userId && isTelegramSessionInvalid(err)) {
    await sessionManager.invalidateTelegramSession(userId)
    return sendSessionInvalid(res)
  }
  const msg = err instanceof Error ? err.message : fallbackMessage
  return sendJson(res, 400, { error: sanitizeClientError(msg) })
}

function sendSessionInvalid(res: ServerResponse) {
  sendJson(res, 401, {
    error: 'telegram_session_invalid',
    code: TELEGRAM_SESSION_INVALID_CODE,
    message: 'Your Telegram session expired. Please connect again.',
  })
}

/** Strip gramjs "(caused by …)" tails from messages shown to users. */
function sanitizeClientError(msg: string): string {
  const idx = msg.indexOf('(caused by')
  return (idx > 0 ? msg.slice(0, idx) : msg).trim() || 'Request failed'
}

/**
 * Authenticated HTTP API consumed only by the supabase telegram-auth
 * edge function. Authenticates with a static internal token so requests
 * cannot originate from the public internet without the secret.
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
      const url = (req.url ?? '').split('?')[0] ?? ''

      if (url === '/health' && (req.method === 'GET' || req.method === 'POST')) {
        const payload = await sessionManager.getHealthPayload()
        return sendJson(res, payload.ok ? 200 : 503, payload)
      }

      if (req.method !== 'POST') {
        return sendJson(res, 404, { error: 'Not found' })
      }

      const token = req.headers['x-internal-token']
      if (token !== INTERNAL_TOKEN) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }

      const body = (await readJson(req)) as Body

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
            return sendJson(res, 200, {
              requires_password: true,
            })
          }
          return sendJson(res, 200, r)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Verification failed'
          return sendJson(res, 400, { error: sanitizeClientError(msg) })
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
          return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to list channels')
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
          return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to backfill channel history')
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
          return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to import backtest history')
        }
      }

      if (url === '/auth/backtest_sync_signals') {
        if (!body.user_id || !body.channel_row_id || !body.from || !body.to) {
          return sendJson(res, 400, { error: 'user_id, channel_row_id, from, and to are required' })
        }
        try {
          const result = await sessionManager.syncBacktestSignals(
            body.user_id,
            body.channel_row_id,
            body.from,
            body.to,
            body.run_id,
          )
          return sendJson(res, 200, result)
        } catch (err: unknown) {
          return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to sync backtest signals')
        }
      }

      return sendJson(res, 404, { error: 'Unknown route' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Internal error'
      console.error('[httpServer] error:', msg)
      return sendJson(res, 500, { error: sanitizeClientError(msg) })
    }
  })

  server.listen(PORT, () => {
    console.log(`[httpServer] listening on :${PORT}`)
  })

  return server
}

/**
 * Trade workers: `/health` + optional `/internal/dispatch-signal` (listener push).
 */
export function startTradeHttpServer(
  sessionManager: UserSessionManager,
  tradeExecutor: TradeExecutor | null,
): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = (req.url ?? '').split('?')[0] ?? ''

      if (url === '/health' && (req.method === 'GET' || req.method === 'POST')) {
        const payload = await sessionManager.getHealthPayload()
        const queue = await getQueueHealthMetrics()
        return sendJson(res, payload.ok ? 200 : 503, {
          ...payload,
          queue,
        })
      }

      if (url === '/internal/dispatch-signal' && req.method === 'POST') {
        if (!INTERNAL_TOKEN) {
          return sendJson(res, 503, { error: 'WORKER_INTERNAL_TOKEN not configured' })
        }
        const token = req.headers['x-internal-token']
        if (token !== INTERNAL_TOKEN) {
          return sendJson(res, 401, { error: 'Unauthorized' })
        }
        if (!tradeExecutor) {
          return sendJson(res, 503, { error: 'trade_executor_not_running' })
        }
        const body = (await readJson(req)) as {
          signal?: Record<string, unknown>
          priority?: 'high' | 'normal'
          source?: string
        }
        const raw = body.signal
        if (!raw || typeof raw.id !== 'string' || typeof raw.user_id !== 'string') {
          return sendJson(res, 400, { error: 'signal.id and signal.user_id required' })
        }
        if (!userBelongsToShard(raw.user_id as string)) {
          return sendJson(res, 200, { accepted: false, reason: 'wrong_shard' })
        }
        const signalRow = {
          ...raw,
          pipeline_ts: (raw as { pipeline_ts?: unknown }).pipeline_ts,
        } as unknown as SignalRow
        const accepted = tradeExecutor.acceptDispatchSignal(signalRow, {
          priority: body.priority,
          source: body.source ?? 'listener_push',
        })
        return sendJson(res, 200, { accepted })
      }

      return sendJson(res, 404, { error: 'Not found' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Internal error'
      console.error('[httpServer] trade http error:', msg)
      return sendJson(res, 500, { error: 'Request failed' })
    }
  })

  server.listen(PORT, () => {
    console.log(`[httpServer] trade API listening on :${PORT}`)
  })

  return server
}

/** @deprecated Use startTradeHttpServer */
export function startHealthOnlyServer(
  sessionManager: UserSessionManager,
  tradeExecutor?: TradeExecutor | null,
): Server {
  return startTradeHttpServer(sessionManager, tradeExecutor ?? null)
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
