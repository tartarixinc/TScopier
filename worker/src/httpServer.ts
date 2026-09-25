import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { AuthService, NO_RESEND_AVAILABLE_ERROR } from './authService'
import {
  isAuthKeyDuplicated,
  TelegramSessionInvalidError,
  TELEGRAM_SESSION_INVALID_CODE,
} from './telegramClient'
import { NO_PENDING_PHONE_AUTH_ERROR } from './telegramAuthRecovery'
import type { SignalRow, TradeExecutor } from './tradeExecutor'
import { UserSessionManager } from './sessionManager'
import { userBelongsToShard } from './workerConfig'
import { getQueueHealthMetrics } from './queue/queueHealth'
import { parseRawChannelMessage } from './parseSignal'
import { getChannelParseContext } from './channelKeywordsCache'
import { getUniversalParseMode, routeSignalParse } from './signalIntent/parseRouting'
import { aiParseModification, aiResultToParseResult } from './aiParseModification'
import { applySignalOverride } from './applySignalOverride'
import { forceCloseSignalById, forceCloseSignalTrades } from './forceCloseSignalTrades'
import { retryTradeActivity } from './retryActivity'
import { retrySignal } from './retrySignal'
import { getBrokerExecutionCapability } from './brokerExecutionMode'

const INTERNAL_TOKEN = process.env.WORKER_INTERNAL_TOKEN ?? ''
const PORT = parseInt(process.env.WORKER_PORT ?? '8080', 10)

interface Body {
  user_id?: string
  phone?: string
  code?: string
  password?: string
  channel_row_id?: string
  days?: number
  for_training?: boolean | string
  from?: string
  to?: string
  run_id?: string
  phone_code_hash?: string
  session_string?: string
  raw_message?: string
  is_reply?: boolean
  parent_signal_id?: string | null
  is_modification_class?: boolean
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
  return sendJson(res, 400, clientErrorPayload(err, fallbackMessage))
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
  const cleaned = (idx > 0 ? msg.slice(0, idx) : msg).trim() || 'Request failed'
  if (isAuthKeyDuplicated(cleaned)) {
    return 'Telegram connection is temporarily busy (another copy is still closing). Wait 30 seconds, press Refresh, or use Reconnect Telegram if it persists.'
  }
  if (/PASSWORD_HASH_INVALID/i.test(cleaned)) {
    return 'Incorrect Two-Step Verification password. Please try again.'
  }
  if (/No pending auth flow/i.test(cleaned)) {
    return 'Login session expired. Go back and request a new verification code.'
  }
  const flood = cleaned.match(/FLOOD_WAIT_(\d+)/i) || cleaned.match(/wait (\d+) seconds/i)
  if (flood) {
    return `Telegram has temporarily limited new login-code requests for this number. Please wait about ${flood[1]} seconds before requesting another code.`
  }
  const resendWait = cleaned.match(/RESEND_WAIT_(\d+)/i)
  if (resendWait) {
    return `Telegram has already sent a login code. You can request another delivery method in ${resendWait[1]} seconds.`
  }
  if (cleaned.includes(NO_RESEND_AVAILABLE_ERROR)) {
    return 'Telegram accepted the login request, but did not offer another code delivery method. Use QR login or check Telegram for a login message.'
  }
  if (/PHONE_NUMBER_FLOOD/i.test(cleaned)) {
    return 'Telegram has temporarily limited new login-code requests for this number. Please wait before requesting another code.'
  }
  if (/PHONE_PASSWORD_FLOOD/i.test(cleaned)) {
    return 'Telegram has temporarily limited Two-Step Verification password attempts. Please wait before trying again.'
  }
  if (/SEND_CODE_UNAVAILABLE/i.test(cleaned)) {
    return 'Telegram has exhausted the available login-code delivery methods for this attempt. Go back and request a new code later.'
  }
  if (/PHONE_NUMBER_INVALID/i.test(cleaned)) {
    return 'Telegram rejected this phone number. Use the full number with country code, then request a new code.'
  }
  if (/PHONE_NUMBER_BANNED/i.test(cleaned)) {
    return 'Telegram rejected this phone number because the Telegram account is banned or restricted.'
  }
  if (/API_ID_PUBLISHED_FLOOD/i.test(cleaned)) {
    return 'Telegram temporarily blocked login-code requests for this app. Contact support.'
  }
  if (/PHONE_CODE_EXPIRED/i.test(cleaned)) {
    return 'This Telegram login code expired. Request a new code and enter the latest one.'
  }
  if (/PHONE_CODE_HASH_EMPTY/i.test(cleaned)) {
    return 'Telegram login state expired. Go back and request a new verification code.'
  }
  if (/PHONE_CODE_INVALID/i.test(cleaned)) {
    return 'That Telegram login code is incorrect. Check the latest code in Telegram and try again.'
  }
  if (/SMS_CODE_CREATE_FAILED/i.test(cleaned)) {
    return 'Telegram could not create an SMS login code for this attempt. Request another delivery method later.'
  }
  if (/UPDATE_APP_TO_LOGIN/i.test(cleaned)) {
    return 'Telegram requires an updated Telegram app to approve this login. Update Telegram and try again.'
  }
  if (/AUTH_RESTART/i.test(cleaned)) {
    return 'Telegram restarted this login attempt. Go back and request a new verification code.'
  }
  if (/TIMEOUT|TIMED OUT|ECONNRESET|NETWORK|SOCKET/i.test(cleaned)) {
    return 'Telegram did not respond in time. Check your connection and request a new code.'
  }
  return cleaned
}

export function clientErrorPayload(err: unknown, fallbackMessage: string): {
  error: string
  message: string
  code?: string
} {
  const msg = err instanceof Error ? err.message : fallbackMessage
  const message = sanitizeClientError(msg)
  const code = err instanceof Error && err.name === NO_PENDING_PHONE_AUTH_ERROR
    ? NO_PENDING_PHONE_AUTH_ERROR
    : undefined
  return code
    ? { error: message, message, code }
    : { error: message, message }
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
          console.warn(`[httpServer] send_code missing fields user_id=${!!body.user_id} phone=${!!body.phone}`)
          return sendJson(res, 400, { error: 'user_id and phone are required' })
        }
        try {
          console.log(`[httpServer] send_code -> authService user=${body.user_id}`)
          const r = await authService.sendCode(body.user_id, body.phone)
          console.log(`[httpServer] send_code OK user=${body.user_id}`)
          return sendJson(res, 200, r)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[httpServer] send_code FAILED user=${body.user_id}: ${msg}`)
          return sendJson(res, 400, clientErrorPayload(err, 'Failed to send code'))
        }
      }

      if (url === '/auth/resend_code') {
        if (!body.user_id || !body.phone) {
          console.warn(`[httpServer] resend_code missing fields user_id=${!!body.user_id} phone=${!!body.phone}`)
          return sendJson(res, 400, { error: 'user_id and phone are required' })
        }
        try {
          console.log(`[httpServer] resend_code -> authService user=${body.user_id}`)
          const r = await authService.resendCode(body.user_id, body.phone)
          console.log(`[httpServer] resend_code OK user=${body.user_id}`)
          return sendJson(res, 200, r)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[httpServer] resend_code FAILED user=${body.user_id}: ${msg}`)
          return sendJson(res, 400, clientErrorPayload(err, 'Failed to resend code'))
        }
      }

      if (url === '/auth/verify_code') {
        if (!body.user_id || !body.phone || !body.code) {
          console.warn(`[httpServer] verify_code missing fields user_id=${!!body.user_id} phone=${!!body.phone} code=${!!body.code}`)
          return sendJson(res, 400, { error: 'user_id, phone, and code are required' })
        }
        try {
          console.log(`[httpServer] verify_code -> authService user=${body.user_id}`)
          const r = await authService.verifyCode(body.user_id, body.phone, body.code, body.password)
          if ('requires_password' in r) {
            console.log(`[httpServer] verify_code requires_password user=${body.user_id}`)
            return sendJson(res, 200, {
              requires_password: true,
            })
          }
          console.log(`[httpServer] verify_code OK user=${body.user_id}`)
          return sendJson(res, 200, r)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[httpServer] verify_code FAILED user=${body.user_id}: ${msg}`)
          return sendJson(res, 400, clientErrorPayload(err, 'Verification failed'))
        }
      }

      if (url === '/auth/start_qr') {
        if (!body.user_id) {
          console.warn('[httpServer] start_qr missing user_id')
          return sendJson(res, 400, { error: 'user_id is required' })
        }
        try {
          console.log(`[httpServer] start_qr -> authService user=${body.user_id}`)
          const r = await authService.startQrLogin(body.user_id)
          console.log(`[httpServer] start_qr OK user=${body.user_id}`)
          return sendJson(res, 200, r)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[httpServer] start_qr FAILED user=${body.user_id}: ${msg}`)
          return sendJson(res, 400, clientErrorPayload(err, 'Failed to start QR login'))
        }
      }

      if (url === '/auth/qr_status') {
        if (!body.user_id) {
          console.warn('[httpServer] qr_status missing user_id')
          return sendJson(res, 400, { error: 'user_id is required' })
        }
        try {
          const r = await authService.getQrStatus(body.user_id)
          console.log(
            `[httpServer] qr_status OK user=${body.user_id}`
            + ` status=${r.status}`
            + ` has_qr_url=${Boolean(r.qr_url)}`
            + ` requires_password=${Boolean(r.requires_password)}`
            + ` has_session=${Boolean(r.session_id)}`,
          )
          return sendJson(res, 200, r)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(`[httpServer] qr_status FAILED user=${body.user_id}: ${msg}`)
          return sendJson(res, 400, clientErrorPayload(err, 'QR status failed'))
        }
      }

      if (url === '/auth/verify_qr_password') {
        if (!body.user_id || !body.password) {
          console.warn('[httpServer] verify_qr_password missing fields')
          return sendJson(res, 400, { error: 'user_id and password are required' })
        }
        try {
          console.log(`[httpServer] verify_qr_password -> authService user=${body.user_id}`)
          const r = await authService.verifyQrPassword(body.user_id, body.password)
          console.log(`[httpServer] verify_qr_password OK user=${body.user_id}`)
          return sendJson(res, 200, r)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[httpServer] verify_qr_password FAILED user=${body.user_id}: ${msg}`)
          return sendJson(res, 400, clientErrorPayload(err, 'QR password verification failed'))
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

      if (url === '/auth/reconnect_telegram') {
        if (!body.user_id) {
          return sendJson(res, 400, { error: 'user_id is required' })
        }
        try {
          const result = await sessionManager.reconnectTelegramSession(body.user_id)
          return sendJson(res, 200, result)
        } catch (err: unknown) {
          return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to reconnect Telegram')
        }
      }

      if (url === '/auth/disconnect_telegram') {
        if (!body.user_id) {
          return sendJson(res, 400, { error: 'user_id is required' })
        }
        try {
          const result = await sessionManager.disconnectTelegramSession(body.user_id)
          return sendJson(res, 200, result)
        } catch (err: unknown) {
          return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to disconnect Telegram')
        }
      }

      if (url === '/auth/backfill_channel_history') {
        if (!body.user_id || !body.channel_row_id) {
          return sendJson(res, 400, { error: 'user_id and channel_row_id are required' })
        }
        try {
          const forTraining = body.for_training === true || body.for_training === 'true'
          const result = await sessionManager.backfillChannelHistory(
            body.user_id,
            body.channel_row_id,
            Number(body.days ?? 30),
            { forTraining },
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

      if (url === '/internal/reconcile-signals') {
        const body = (await readJson(req)) as {
          user_id?: string
          channel_row_id?: string
        }
        if (body.user_id) {
          if (!userBelongsToShard(body.user_id)) {
            return sendJson(res, 200, { ok: false, reason: 'wrong_shard' })
          }
          try {
            const result = await sessionManager.reconcileUserSignals(body.user_id, {
              channelRowId: body.channel_row_id,
            })
            return sendJson(res, 200, result)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'reconcile failed'
            return sendJson(res, 500, { error: msg })
          }
        }
        const result = await sessionManager.reconcileAllListenersOnShard()
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (url === '/internal/parse-ai-debug') {
        if (!body.channel_row_id || typeof body.raw_message !== 'string') {
          return sendJson(res, 400, { error: 'channel_row_id and raw_message required' })
        }
        try {
          const supabase = sessionManager.getSupabase()
          const { keywords, lexicon } = await getChannelParseContext(supabase, body.channel_row_id)
          const pipelineTs: Record<string, unknown> = {}
          const started = Date.now()
          const routed = await routeSignalParse({
            supabase,
            userId: body.user_id ?? 'debug-user',
            channelRowId: body.channel_row_id,
            signalId: `debug-${Date.now()}`,
            rawMessage: body.raw_message,
            isReply: body.is_reply === true,
            parentSignalId: body.parent_signal_id ?? null,
            isModificationClass: body.is_modification_class === true,
            keywords,
            lexicon,
            pipelineTs,
          })
          return sendJson(res, 200, {
            mode: getUniversalParseMode(),
            aiMeta: routed.aiMeta ?? null,
            verification: routed.verification ?? null,
            pipeline_ts: pipelineTs,
            parse_result: {
              action: routed.parseResult.parsed.action,
              symbol: routed.parseResult.parsed.symbol ?? null,
              confidence: typeof routed.parseResult.parsed.confidence === 'number'
                ? routed.parseResult.parsed.confidence
                : null,
              status: routed.parseResult.status,
              skip_reason: routed.parseResult.skip_reason ?? null,
            },
            elapsed_ms: Date.now() - started,
          })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'parse failed'
          return sendJson(res, 500, { error: msg })
        }
      }

      return sendJson(res, 404, { error: 'Unknown route' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Internal error'
      console.error('[httpServer] error:', msg)
      return sendJson(res, 500, clientErrorPayload(err, 'Internal error'))
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
        const brokerCapability = getBrokerExecutionCapability()
        return sendJson(res, payload.ok ? 200 : 503, {
          ...payload,
          queue,
          ...brokerCapability,
        })
      }

      if (url === '/internal/parse-signal' && req.method === 'POST') {
        if (!INTERNAL_TOKEN) {
          return sendJson(res, 503, { error: 'WORKER_INTERNAL_TOKEN not configured' })
        }
        const token = req.headers['x-internal-token']
        if (token !== INTERNAL_TOKEN) {
          return sendJson(res, 401, { error: 'Unauthorized' })
        }
        const body = (await readJson(req)) as {
          channel_row_id?: string
          raw_message?: string
          user_id?: string
        }
        if (!body.channel_row_id || typeof body.raw_message !== 'string') {
          return sendJson(res, 400, { error: 'channel_row_id and raw_message required' })
        }
        if (body.user_id && !userBelongsToShard(body.user_id)) {
          return sendJson(res, 200, { parsed: null, status: 'skipped', reason: 'wrong_shard' })
        }
        try {
          const result = await parseRawChannelMessage(
            sessionManager.getSupabase(),
            body.channel_row_id,
            body.raw_message,
          )
          return sendJson(res, 200, {
            parsed: result.parsed,
            status: result.status,
            skip_reason: result.skip_reason,
          })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'parse failed'
          return sendJson(res, 500, { error: msg })
        }
      }

      if (url === '/internal/parse-modification' && req.method === 'POST') {
        if (!INTERNAL_TOKEN) {
          return sendJson(res, 503, { error: 'WORKER_INTERNAL_TOKEN not configured' })
        }
        const token = req.headers['x-internal-token']
        if (token !== INTERNAL_TOKEN) {
          return sendJson(res, 401, { error: 'Unauthorized' })
        }
        const body = (await readJson(req)) as {
          channel_row_id?: string
          raw_message?: string
          user_id?: string
          is_reply?: boolean
          parent_signal_id?: string | null
          revision?: {
            prior_raw_message?: string
            prior_parsed_data?: Record<string, unknown> | null
          }
          force_ai?: boolean
        }
        if (!body.channel_row_id || typeof body.raw_message !== 'string' || !body.user_id) {
          return sendJson(res, 400, { error: 'channel_row_id, raw_message, and user_id required' })
        }
        if (!userBelongsToShard(body.user_id)) {
          return sendJson(res, 200, { parsed: null, status: 'skipped', reason: 'wrong_shard' })
        }
        try {
          const aiResult = await aiParseModification(sessionManager.getSupabase(), {
            userId: body.user_id,
            channelRowId: body.channel_row_id,
            rawMessage: body.raw_message,
            isReply: body.is_reply === true,
            parentSignalId: body.parent_signal_id ?? null,
            revision: body.revision?.prior_raw_message
              ? {
                  prior_raw_message: body.revision.prior_raw_message,
                  prior_parsed_data: body.revision.prior_parsed_data ?? null,
                }
              : undefined,
            forceAi: body.force_ai === true,
          })
          const parseResult = aiResultToParseResult(aiResult)
          return sendJson(res, 200, {
            parsed: parseResult.parsed,
            status: parseResult.status,
            skip_reason: parseResult.skip_reason,
            intent: aiResult.intent,
            typo_corrected: aiResult.typo_corrected,
            confidence: aiResult.confidence,
            source: aiResult.source,
          })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'parse modification failed'
          return sendJson(res, 500, { error: msg })
        }
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
          await?: boolean
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
        const dispatchOpts = {
          priority: body.priority,
          source: body.source ?? 'listener_push',
        }
        const awaitByDefault = String(process.env.TRADE_DISPATCH_AWAIT_DEFAULT ?? 'false').toLowerCase() === 'true'
        const shouldAwait = body.await === true
          || (body.await !== false && awaitByDefault)
        const accepted = shouldAwait
          ? await tradeExecutor.acceptDispatchSignalAwait(signalRow, dispatchOpts)
          : tradeExecutor.acceptDispatchSignal(signalRow, dispatchOpts)
        return sendJson(res, 200, { accepted, awaited: shouldAwait })
      }

      if (url === '/internal/retry-activity' && req.method === 'POST') {
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
          user_id?: string
          log_id?: string
        }
        const userId = body.user_id?.trim()
        const logId = body.log_id?.trim()
        if (!userId || !logId) {
          return sendJson(res, 400, { error: 'user_id and log_id required' })
        }
        if (!userBelongsToShard(userId)) {
          return sendJson(res, 200, { ok: false, reason: 'wrong_shard' })
        }
        try {
          const result = await retryTradeActivity(tradeExecutor, { userId, logId })
          return sendJson(res, 200, result)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'retry failed'
          return sendJson(res, 500, { error: msg })
        }
      }

      if (url === '/internal/retry-signal' && req.method === 'POST') {
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
          user_id?: string
          signal_id?: string
        }
        const userId = body.user_id?.trim()
        const signalId = body.signal_id?.trim()
        if (!userId || !signalId) {
          return sendJson(res, 400, { error: 'user_id and signal_id required' })
        }
        if (!userBelongsToShard(userId)) {
          return sendJson(res, 200, { ok: false, reason: 'wrong_shard' })
        }
        try {
          const result = await retrySignal(tradeExecutor, { userId, signalId })
          return sendJson(res, 200, result)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'retry failed'
          return sendJson(res, 500, { error: msg })
        }
      }

      if (url === '/internal/apply-signal-override' && req.method === 'POST') {
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
          user_id?: string
          signal_id?: string
        }
        const userId = body.user_id?.trim()
        const signalId = body.signal_id?.trim()
        if (!userId || !signalId) {
          return sendJson(res, 400, { error: 'user_id and signal_id required' })
        }
        if (!userBelongsToShard(userId)) {
          return sendJson(res, 200, { applied_legs: 0, skipped_legs: 0, failed_legs: 0, reason: 'wrong_shard' })
        }
        try {
          const result = await applySignalOverride(tradeExecutor.supabase, { userId, signalId })
          return sendJson(res, 200, result)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'apply failed'
          return sendJson(res, 500, { error: msg })
        }
      }

      if (url === '/internal/force-close-trades' && req.method === 'POST') {
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
          user_id?: string
          broker_account_id?: string
          channel_id?: string | null
          signal_id?: string | null
        }
        const userId = body.user_id?.trim()
        const brokerAccountId = body.broker_account_id?.trim()
        const signalId = body.signal_id?.trim() || null
        if (!userId || (!brokerAccountId && !signalId)) {
          return sendJson(res, 400, { error: 'user_id and broker_account_id (or signal_id) required' })
        }
        if (!userBelongsToShard(userId)) {
          return sendJson(res, 200, {
            ok: false,
            closed: 0,
            failed: 0,
            pending_cancelled: 0,
            virtual_legs_deleted: 0,
            channels_processed: 0,
            reason: 'wrong_shard',
          })
        }
        try {
          const result = signalId
            ? await forceCloseSignalById(tradeExecutor.supabase, { userId, signalId })
            : await forceCloseSignalTrades(tradeExecutor.supabase, {
                userId,
                brokerAccountId: brokerAccountId!,
                channelId: body.channel_id?.trim() || null,
              })
          return sendJson(res, 200, result)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'force close failed'
          return sendJson(res, 500, { error: msg })
        }
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
