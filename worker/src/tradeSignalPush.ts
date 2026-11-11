/**
 * Listener → trade worker HTTP push (split deploy). Supabase Realtime remains fallback.
 */

import type { ParsedSignal } from './manualPlanning/types'
import { dispatchPriorityForAction, isManagementAction, parsedAction } from './tradeSignalActions'
import type { PipelineTimestamps } from './pipelineTimestamps'
import { deployedTradeShardCount, redisQueueConfigured, signalQueueConfig } from './queue/signalQueueConfig'
import { shardForUserId } from './workerConfig'
import { captureBusinessIssue } from './observability/businessEvents'
import { configuredInternalToken, internalTokenFingerprint } from './internalToken'

export type TradeSignalPushPayload = {
  id: string
  user_id: string
  channel_id: string | null
  parsed_data: ParsedSignal | null
  status: string
  parent_signal_id?: string | null
  is_modification?: boolean
  telegram_message_id?: string | null
  reply_to_message_id?: string | null
  created_at?: string
  pipeline_ts?: PipelineTimestamps
  dispatch_source?: string
  revision_prior_action?: string | null
}

const PUSH_MAX_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.TRADE_SIGNAL_PUSH_MAX_ATTEMPTS ?? 2)))
const PUSH_RETRY_BASE_MS = Math.max(25, Math.min(500, Number(process.env.TRADE_SIGNAL_PUSH_RETRY_BASE_MS ?? 50)))
const PUSH_PROBE_INTERVAL_MS = Math.max(
  10_000,
  Math.min(300_000, Number(process.env.TRADE_SIGNAL_PUSH_PROBE_INTERVAL_MS ?? 30_000)),
)
const BREAKER_COOLDOWN_MS = Math.max(
  5_000,
  Math.min(300_000, Number(process.env.TRADE_SIGNAL_PUSH_BREAKER_COOLDOWN_MS ?? 30_000)),
)
const SUPABASE_URL = String(process.env.SUPABASE_URL ?? '').trim()
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()

type PushAttemptResult = {
  ok: boolean
  status: number
  retryable: boolean
  detail: string
  reason?: string | null
  accepted?: boolean | null
}

type BreakerState = {
  openUntil: number
  lastStatus: number
  lastDetail: string
  alerted: boolean
}

const pushBreakers = new Map<string, BreakerState>()
let pushProbeTimer: ReturnType<typeof setInterval> | null = null

function tradePushEnabled(): boolean {
  const v = String(process.env.TRADE_SIGNAL_PUSH_ENABLED ?? 'true').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

function internalToken(): string {
  return configuredInternalToken()
}

function breakerOpen(baseUrl: string): BreakerState | null {
  const state = pushBreakers.get(baseUrl)
  if (!state) return null
  if (Date.now() >= state.openUntil) {
    pushBreakers.delete(baseUrl)
    return null
  }
  return state
}

function openBreaker(baseUrl: string, status: number, detail: string): void {
  const prev = pushBreakers.get(baseUrl)
  const state: BreakerState = {
    openUntil: Date.now() + BREAKER_COOLDOWN_MS,
    lastStatus: status,
    lastDetail: detail.slice(0, 200),
    alerted: prev?.alerted === true,
  }
  pushBreakers.set(baseUrl, state)
  if (!state.alerted) {
    state.alerted = true
    captureBusinessIssue({
      category: 'queue',
      event: 'trade_worker_push_breaker_open',
      severity: 'error',
      reasonCode: 'TRADE_WORKER_PUSH_AUTH_OR_ROUTE',
      message: 'Listener→trade push circuit opened (auth/route failure); signals fall back until probe recovers',
      userImpact: 'delayed',
      fingerprint: ['trade_worker_push_breaker', baseUrl, String(status)],
      context: {
        operation: 'trade_worker_push_breaker',
        extra: { base_url: baseUrl, status, detail: state.lastDetail },
      },
    })
    console.error(
      `[tradeSignalPush] breaker OPEN url=${baseUrl} status=${status} detail=${state.lastDetail}`,
    )
  }
}

function clearBreaker(baseUrl: string): void {
  if (pushBreakers.delete(baseUrl)) {
    console.log(`[tradeSignalPush] breaker CLOSED url=${baseUrl}`)
  }
}

function configuredTradeWorkerBaseUrls(): string[] {
  const urls = new Set<string>()
  for (const u of parseTradeWorkerShardUrls(process.env.TRADE_WORKER_SHARD_URLS)) urls.add(u)
  for (const u of parseTradeWorkerShardUrls(process.env.TRADE_MGMT_WORKER_SHARD_URLS)) urls.add(u)
  const entry = String(process.env.TRADE_WORKER_URL ?? '').trim().replace(/\/$/, '')
  const mgmt = String(process.env.TRADE_MGMT_WORKER_URL ?? '').trim().replace(/\/$/, '')
  if (entry) urls.add(entry)
  if (mgmt) urls.add(mgmt)
  return [...urls]
}

export function parseTradeWorkerShardUrls(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return raw.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
}

export function pickTradeWorkerUrl(action: string, userId?: string): string | null {
  const shardUrls = parseTradeWorkerShardUrls(process.env.TRADE_WORKER_SHARD_URLS)
  const mgmtShardUrls = parseTradeWorkerShardUrls(process.env.TRADE_MGMT_WORKER_SHARD_URLS)
  const entryUrl = String(process.env.TRADE_WORKER_URL ?? '').trim().replace(/\/$/, '')
  const mgmtUrl = String(process.env.TRADE_MGMT_WORKER_URL ?? '').trim().replace(/\/$/, '')
  const mgmt = isManagementAction(action)

  // Sharded management routing takes precedence for mgmt actions so heavy
  // management bursts (Adjust SL/TP, breakeven, close half on a busy channel)
  // fan out across the management fleet instead of hammering one mgmt URL.
  if (mgmt && mgmtShardUrls.length > 1 && userId) {
    const sharded = mgmtShardUrls[shardForUserId(userId, mgmtShardUrls.length)]
    if (sharded) return sharded
  }
  if (mgmt && mgmtShardUrls.length === 1) {
    return mgmtShardUrls[0]!
  }

  let base: string | null
  if (mgmt) {
    base = mgmtUrl || entryUrl || null
  } else {
    base = entryUrl || null
  }

  if (shardUrls.length > 1 && userId) {
    const shard = shardForUserId(userId, shardUrls.length)
    const sharded = shardUrls[shard]
    if (sharded) {
      if (mgmt && mgmtUrl) return mgmtUrl
      return sharded
    }
  }

  if (shardUrls.length === 1 && userId && !mgmt) {
    return shardUrls[0]!
  }

  return base
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryablePushStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408
}

function logPushFailed(
  row: TradeSignalPushPayload,
  baseUrl: string,
  action: string,
  reason: string,
  attempt: number,
): void {
  captureBusinessIssue({
    category: 'queue',
    event: 'signal_dispatch_failed',
    severity: 'error',
    reasonCode: 'TRADE_WORKER_PUSH_FAILED',
    message: 'Telegram signal was accepted but dispatch to trade worker failed after retries',
    userImpact: 'failed',
    fingerprint: ['signal_dispatch_failed', 'trade_worker_push', 'TRADE_WORKER_PUSH_FAILED', action],
    context: {
      user_id: row.user_id,
      signal_id: row.id,
      channel_id: row.channel_id,
      telegram_message_id: row.telegram_message_id,
      dispatch_source: row.dispatch_source ?? 'listener_push',
      operation: 'trade_worker_push',
      retry_attempt: attempt,
      extra: {
        action,
        attempt,
        max_attempts: PUSH_MAX_ATTEMPTS,
        reason,
        target_configured: Boolean(baseUrl),
      },
    },
  })
  console.warn(
    JSON.stringify({
      event: 'push_failed',
      user_id: row.user_id,
      signal_id: row.id,
      action,
      url: baseUrl,
      attempt,
      max_attempts: PUSH_MAX_ATTEMPTS,
      reason,
    }),
  )
}

async function logPushAttemptToDb(
  row: TradeSignalPushPayload,
  status: 'success' | 'failed',
  payload: Record<string, unknown>,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/trade_execution_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify([{
        user_id: row.user_id,
        signal_id: row.id,
        action: 'dispatch_push_attempt',
        status,
        request_payload: payload,
      }]),
    })
    if (!res.ok) {
      console.warn(
        `[tradeSignalPush] dispatch_push_attempt insert rejected signal=${row.id} user=${row.user_id} http=${res.status}`,
      )
    }
  } catch (err) {
    console.warn(
      `[tradeSignalPush] failed to persist dispatch_push_attempt signal=${row.id} user=${row.user_id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

async function postDispatchSignal(
  url: string,
  token: string,
  signalBody: Record<string, unknown>,
  priority: string,
  timeoutMs: number,
  awaitExecution = false,
  source = 'listener_push',
): Promise<PushAttemptResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('trade-push-timeout'), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': token,
      },
      body: JSON.stringify({
        signal: signalBody,
        priority,
        source,
        await: awaitExecution,
      }),
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')
    let body: { accepted?: unknown; reason?: unknown; error?: unknown } | null = null
    if (text) {
      try {
        body = JSON.parse(text) as { accepted?: unknown; reason?: unknown; error?: unknown }
      } catch {
        body = null
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        retryable: isRetryablePushStatus(res.status),
        detail: text.slice(0, 200),
        reason: typeof body?.error === 'string' ? body.error : typeof body?.reason === 'string' ? body.reason : null,
        accepted: false,
      }
    }
    // HTTP 200 with accepted:false (wrong shard / wrong role) is NOT a successful handoff.
    if (body?.accepted !== true) {
      const reason = typeof body?.reason === 'string'
        ? body.reason
        : body == null
          ? 'missing_accepted_field'
          : 'accepted_false'
      return {
        ok: false,
        status: res.status,
        retryable: false,
        detail: text.slice(0, 200) || reason,
        reason,
        accepted: false,
      }
    }
    return {
      ok: true,
      status: res.status,
      retryable: false,
      detail: '',
      reason: typeof body?.reason === 'string' ? body.reason : null,
      accepted: true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, retryable: true, detail: msg, accepted: false }
  } finally {
    clearTimeout(timer)
  }
}

async function pushParsedSignalToTradeWorkerInner(
  row: TradeSignalPushPayload,
  opts?: { awaitExecution?: boolean; source?: string },
): Promise<boolean> {
  if (!tradePushEnabled()) {
    console.warn('[tradeSignalPush] disabled (TRADE_SIGNAL_PUSH_ENABLED=false)')
    return false
  }
  const token = internalToken()
  if (!token) {
    console.warn('[tradeSignalPush] missing WORKER_INTERNAL_TOKEN — cannot push to trade worker')
    return false
  }

  const action = parsedAction(row.parsed_data as { action?: string })
  const baseUrl = pickTradeWorkerUrl(action, row.user_id)
  if (!baseUrl) {
    console.warn(
      `[tradeSignalPush] no trade worker URL for action=${action} user=${row.user_id}`
      + ' — set TRADE_WORKER_URL / TRADE_MGMT_WORKER_URL on listener',
    )
    return false
  }

  const open = breakerOpen(baseUrl)
  if (open) {
    void logPushAttemptToDb(row, 'failed', {
      run_id: 'latency-v4',
      phase: 'breaker_short_circuit',
      action,
      ok: false,
      status_code: open.lastStatus,
      detail: open.lastDetail.slice(0, 120),
      base_url: baseUrl,
    })
    return false
  }

  const timeoutMs = Math.max(
    500,
    Math.min(10_000, Number(process.env.TRADE_SIGNAL_PUSH_TIMEOUT_MS ?? 1_000)),
  )
  const dispatchSource = opts?.source ?? row.dispatch_source ?? 'listener_push'
  const url = `${baseUrl}/internal/dispatch-signal`
  const priority = dispatchPriorityForAction(action)

  const signalBody = {
    id: row.id,
    user_id: row.user_id,
    channel_id: row.channel_id,
    parsed_data: row.parsed_data,
    status: row.status,
    parent_signal_id: row.parent_signal_id ?? null,
    is_modification: row.is_modification ?? false,
    telegram_message_id: row.telegram_message_id ?? null,
    reply_to_message_id: row.reply_to_message_id ?? null,
    created_at: row.created_at,
    pipeline_ts: row.pipeline_ts,
    dispatch_source: row.dispatch_source ?? null,
    revision_prior_action: row.revision_prior_action ?? null,
  }

  void logPushAttemptToDb(row, 'success', {
    run_id: 'latency-v4',
    phase: 'start',
    action,
    base_url: baseUrl,
    timeout_ms: timeoutMs,
    max_attempts: PUSH_MAX_ATTEMPTS,
    await_execution: opts?.awaitExecution === true,
    dispatch_source: dispatchSource,
  })

  for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt++) {
    const attemptStartedAt = Date.now()
    const result = await postDispatchSignal(
      url,
      token,
      signalBody,
      priority,
      timeoutMs,
      opts?.awaitExecution === true,
      dispatchSource,
    )
    void logPushAttemptToDb(row, result.ok ? 'success' : 'failed', {
      run_id: 'latency-v4',
      phase: 'attempt',
      action,
      attempt,
      ok: result.ok,
      accepted: result.accepted ?? null,
      reason: result.reason ?? null,
      status_code: result.status,
      retryable: result.retryable,
      elapsed_ms: Date.now() - attemptStartedAt,
      detail: result.detail.slice(0, 120),
    })
    if (result.ok) {
      clearBreaker(baseUrl)
      return true
    }

    const reason = result.status > 0
      ? `status=${result.status} ${result.reason ?? result.detail}`
      : result.detail

    // Auth / missing route: open breaker; do not burn retries.
    if (result.status === 401 || result.status === 403 || result.status === 404) {
      openBreaker(baseUrl, result.status, reason)
      logPushFailed(row, baseUrl, action, reason, attempt)
      return false
    }

    if (!result.retryable || attempt >= PUSH_MAX_ATTEMPTS) {
      logPushFailed(row, baseUrl, action, reason, attempt)
      return false
    }

    const backoffMs = PUSH_RETRY_BASE_MS * attempt
    await sleep(backoffMs)
  }
  return false
}

/** Probe every configured trade worker URL; used at listener boot and on an interval. */
export async function probeTradeWorkerDispatchTargets(): Promise<{
  ok: boolean
  results: Array<{ baseUrl: string; ok: boolean; status: number; detail: string }>
}> {
  const token = internalToken()
  const results: Array<{ baseUrl: string; ok: boolean; status: number; detail: string }> = []
  if (!token || !tradePushEnabled()) {
    return { ok: true, results }
  }
  const urls = configuredTradeWorkerBaseUrls()
  for (const baseUrl of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('dispatch-ping-timeout'), 2_000)
    try {
      const res = await fetch(`${baseUrl}/internal/dispatch-ping`, {
        method: 'GET',
        headers: { 'x-internal-token': token },
        signal: controller.signal,
      })
      const text = await res.text().catch(() => '')
      if (res.ok) {
        clearBreaker(baseUrl)
        results.push({ baseUrl, ok: true, status: res.status, detail: text.slice(0, 120) })
      } else {
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          openBreaker(baseUrl, res.status, text.slice(0, 200))
        }
        results.push({ baseUrl, ok: false, status: res.status, detail: text.slice(0, 120) })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ baseUrl, ok: false, status: 0, detail: msg.slice(0, 120) })
    } finally {
      clearTimeout(timer)
    }
  }
  const ok = results.length === 0 || results.every(r => r.ok)
  return { ok, results }
}

/** Start periodic push probes (listener process). Returns a stop function. */
export function startTradePushProbeLoop(): () => void {
  const fp = internalTokenFingerprint()
  console.log(`[tradeSignalPush] internal token fingerprint=${fp ?? 'missing'}`)
  void probeTradeWorkerDispatchTargets().then(r => {
    for (const row of r.results) {
      console.log(
        `[tradeSignalPush] probe ${row.ok ? 'ok' : 'FAIL'} url=${row.baseUrl} status=${row.status} detail=${row.detail}`,
      )
    }
  })
  if (pushProbeTimer) clearInterval(pushProbeTimer)
  pushProbeTimer = setInterval(() => {
    void probeTradeWorkerDispatchTargets()
  }, PUSH_PROBE_INTERVAL_MS)
  pushProbeTimer.unref?.()
  return () => {
    if (pushProbeTimer) clearInterval(pushProbeTimer)
    pushProbeTimer = null
  }
}

/** Test helper — clear breakers between cases. */
export function resetTradePushBreakersForTests(): void {
  pushBreakers.clear()
}

/** Fire-and-forget push — listener must not block on trade completion. */
export function pushParsedSignalToTradeWorker(
  row: TradeSignalPushPayload,
  opts?: { source?: string },
): void {
  void pushParsedSignalToTradeWorkerInner(row, {
    awaitExecution: false,
    source: opts?.source ?? row.dispatch_source,
  })
}

/** Awaitable push — worker accepts dispatch only; execution continues in-process (mgmt hot path). */
export async function pushParsedSignalToTradeWorkerAccept(
  row: TradeSignalPushPayload,
  opts?: { source?: string },
): Promise<boolean> {
  return pushParsedSignalToTradeWorkerInner(row, {
    awaitExecution: false,
    source: opts?.source ?? row.dispatch_source,
  })
}

/** Await full handleSignal completion (queue consumer / diagnostics only). */
export async function pushParsedSignalToTradeWorkerAwait(
  row: TradeSignalPushPayload,
  opts?: { source?: string },
): Promise<boolean> {
  return pushParsedSignalToTradeWorkerInner(row, {
    awaitExecution: true,
    source: opts?.source ?? row.dispatch_source,
  })
}

/**
 * Listener startup check: TRADE_WORKER_SHARD_URLS count must match TRADE_WORKER_SHARD_COUNT.
 * Returns error message or null if valid / not applicable.
 */
export function validateListenerTradeShardConfig(): string | null {
  const shardUrls = parseTradeWorkerShardUrls(process.env.TRADE_WORKER_SHARD_URLS)
  if (shardUrls.length === 0) return null

  const expectedRaw = process.env.TRADE_WORKER_SHARD_COUNT
  const expected = expectedRaw != null && expectedRaw !== ''
    ? Math.max(1, Math.floor(Number(expectedRaw)))
    : shardUrls.length

  if (!Number.isFinite(expected) || expected < 1) {
    return `TRADE_WORKER_SHARD_COUNT must be a positive integer (got ${expectedRaw})`
  }
  if (shardUrls.length !== expected) {
    return `TRADE_WORKER_SHARD_URLS has ${shardUrls.length} URL(s) but TRADE_WORKER_SHARD_COUNT=${expected}`
  }
  return null
}

/**
 * Listener startup check: TRADE_MGMT_WORKER_SHARD_URLS (when set) must match the
 * trade shard count so management dispatch hashes onto an existing mgmt shard.
 * Returns an error message or null if valid / not applicable.
 */
export function validateListenerMgmtShardConfig(): string | null {
  const mgmtShardUrls = parseTradeWorkerShardUrls(process.env.TRADE_MGMT_WORKER_SHARD_URLS)
  if (mgmtShardUrls.length === 0) return null

  const expectedRaw = process.env.TRADE_WORKER_SHARD_COUNT
  const expected = expectedRaw != null && expectedRaw !== ''
    ? Math.max(1, Math.floor(Number(expectedRaw)))
    : mgmtShardUrls.length

  if (!Number.isFinite(expected) || expected < 1) {
    return `TRADE_WORKER_SHARD_COUNT must be a positive integer (got ${expectedRaw})`
  }
  if (mgmtShardUrls.length !== expected) {
    return `TRADE_MGMT_WORKER_SHARD_URLS has ${mgmtShardUrls.length} URL(s) but TRADE_WORKER_SHARD_COUNT=${expected}`
  }
  return null
}

/**
 * Listener startup check for Redis queue env when queue mode is enabled.
 */
export function validateListenerQueueConfig(): string | null {
  const cfg = signalQueueConfig()
  if (!cfg.enabled) return null
  if (!redisQueueConfigured()) {
    return 'TRADE_SIGNAL_QUEUE_ENABLED=true but UPSTASH_REDIS_REST_URL/TOKEN (or REDIS_REST_*) are missing'
  }
  if (cfg.shardCount < 1) {
    return 'TRADE_SIGNAL_QUEUE_SHARD_COUNT must be >= 1'
  }
  const tradeShards = deployedTradeShardCount()
  if (cfg.shardCount > tradeShards) {
    return `TRADE_SIGNAL_QUEUE_SHARD_COUNT=${cfg.shardCount} exceeds deployed trade shards (${tradeShards}).`
      + ' Set TRADE_SIGNAL_QUEUE_SHARD_COUNT=1 for a single trade worker, or add matching trade shards.'
  }
  const shardUrls = parseTradeWorkerShardUrls(process.env.TRADE_WORKER_SHARD_URLS)
  if (shardUrls.length > 0 && cfg.shardCount !== shardUrls.length) {
    return `TRADE_SIGNAL_QUEUE_SHARD_COUNT=${cfg.shardCount} must match TRADE_WORKER_SHARD_URLS count (${shardUrls.length})`
  }
  return null
}
