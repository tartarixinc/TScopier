import * as Sentry from '@sentry/node'
import { workerConfig, WORKER_BUILD_TAG } from '../workerConfig'
import { getBrokerExecutionCapability } from '../brokerExecutionMode'
import { safeForSentry, normalizedErrorCode } from './sentryRedaction'
import { buildSafePipelineContext, type WorkerSentryContextInput } from './sentryContext'

type SentryAdapter = Pick<typeof Sentry,
  | 'init'
  | 'captureException'
  | 'captureMessage'
  | 'captureCheckIn'
  | 'addBreadcrumb'
  | 'setTag'
  | 'setContext'
  | 'withScope'
  | 'flush'
  | 'logger'
>

type CaptureOptions = {
  subsystem: string
  operation: string
  level?: 'fatal' | 'error' | 'warning' | 'info'
  fingerprint?: string[]
  context?: WorkerSentryContextInput
  extra?: Record<string, unknown>
  errorCode?: string
  tags?: Record<string, string | number | boolean | null | undefined>
}

let sentry: SentryAdapter = Sentry
let enabled = false
let initialized = false
let processHandlersInstalled = false
let fatalCaptureInFlight = false
let uncaughtHandler: ((err: Error) => void) | null = null
let rejectionHandler: ((reason: unknown) => void) | null = null
let invalidDsnWarningEmitted = false
const fatalErrors = new WeakSet<object>()
const fatalSignatures = new Map<string, number>()

const ALLOWED_BREADCRUMB_CATEGORIES = new Set([
  'account',
  'auth',
  'broker',
  'copier',
  'layering',
  'management',
  'persistence',
  'queue',
  'range',
  'reconciliation',
  'trade',
  'telegram',
  'worker',
])
const ALLOWED_BREADCRUMB_LEVELS = new Set(['debug', 'info', 'warning', 'error'])

function envBool(raw: string | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'true'
}

function hasWhitespaceOrControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (code <= 32 || code === 127) return true
  }
  return false
}

export function isValidSentryDsn(value: unknown): boolean {
  try {
    if (typeof value !== 'string') return false
    const trimmed = value.trim()
    if (!trimmed || trimmed !== value) return false
    if (hasWhitespaceOrControl(value)) return false
    if (/%(?![0-9A-Fa-f]{2})/.test(value)) return false
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (!url.hostname) return false
    if (!url.username) return false
    if (url.password) return false
    if (url.hash) return false
    if (url.search) return false
    const publicKey = decodeURIComponent(url.username)
    if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) return false
    const pathParts = url.pathname.split('/').filter(Boolean)
    const projectId = pathParts.at(-1)
    if (!projectId || !/^\d+$/.test(projectId)) return false
    return true
  } catch {
    return false
  }
}

function warnInvalidDsnOnce(): void {
  if (invalidDsnWarningEmitted) return
  invalidDsnWarningEmitted = true
  console.warn('[sentry] disabled: invalid DSN configuration')
}

function safeName(value: string, fallback: string): string {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 80)
  return normalized || fallback
}

function releaseFromEnv(env: NodeJS.ProcessEnv): string {
  return String(
    env.SENTRY_RELEASE
    ?? env.RAILWAY_GIT_COMMIT_SHA
    ?? env.RAILWAY_DEPLOYMENT_ID
    ?? WORKER_BUILD_TAG,
  ).trim()
}

function environmentFromEnv(env: NodeJS.ProcessEnv): string {
  return String(env.SENTRY_ENVIRONMENT ?? env.RAILWAY_ENVIRONMENT_NAME ?? env.NODE_ENV ?? 'production')
    .trim()
    .toLowerCase()
}

export function isWorkerSentryEnabled(): boolean {
  return enabled
}

export function setSentryAdapterForTests(adapter: SentryAdapter): void {
  sentry = adapter
}

export function resetWorkerSentryForTests(): void {
  enabled = false
  initialized = false
  processHandlersInstalled = false
  fatalCaptureInFlight = false
  uncaughtHandler = null
  rejectionHandler = null
  invalidDsnWarningEmitted = false
  fatalSignatures.clear()
  logNoiseEnabled = true
  logNoisePatterns = [...DEFAULT_LOG_NOISE_PATTERNS]
  sentry = Sentry
}

function sanitizeTags(tags: unknown): Record<string, string> | undefined {
  const safe = safeForSentry(tags)
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(safe as Record<string, unknown>).slice(0, 20)) {
    out[safeName(key, 'tag')] = String(value ?? '').slice(0, 160)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeEvent(event: unknown): Record<string, unknown> {
  const safe = safeForSentry(event)
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) {
    return { message: String(safeForSentry(String(safe ?? 'event'))), level: 'error' }
  }
  const src = safe as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of ['event_id', 'timestamp', 'platform', 'level', 'logger', 'release', 'environment', 'message']) {
    if (src[key] !== undefined) out[key] = src[key]
  }
  if (Array.isArray(src.fingerprint)) out.fingerprint = src.fingerprint.slice(0, 5).map(v => String(v).slice(0, 120))
  const tags = sanitizeTags(src.tags)
  if (tags) out.tags = tags
  const contexts = src.contexts
  if (contexts && typeof contexts === 'object' && !Array.isArray(contexts)) {
    const c = contexts as Record<string, unknown>
    out.contexts = {
      pipeline: c.pipeline,
      worker: c.worker,
      durations: c.durations,
    }
  }
  const extra = src.extra
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    const e = extra as Record<string, unknown>
    out.extra = e.safe_extra !== undefined ? { safe_extra: e.safe_extra } : undefined
  }
  if (Array.isArray(src.breadcrumbs)) out.breadcrumbs = src.breadcrumbs.slice(-25)
  if (src.exception !== undefined) out.exception = src.exception
  return out
}

function beforeSend(event: unknown): unknown {
  return sanitizeEvent(event)
}

function beforeBreadcrumb(breadcrumb: unknown): unknown {
  const safe = safeForSentry(breadcrumb)
  if (safe && typeof safe === 'object' && !Array.isArray(safe)) {
    const crumb = safe as Record<string, unknown>
    const category = safeName(String(crumb.category ?? ''), 'worker')
    const level = ALLOWED_BREADCRUMB_LEVELS.has(String(crumb.level)) ? String(crumb.level) : 'info'
    if (!ALLOWED_BREADCRUMB_CATEGORIES.has(category)) {
      return { category: 'worker', message: '[REDACTED_BREADCRUMB]', level }
    }
    return {
      category,
      message: String(safeForSentry(String(crumb.message ?? ''))).slice(0, 240),
      level,
      data: safeForSentry(crumb.data),
    }
  }
  return { category: 'worker', message: '[REDACTED_BREADCRUMB]', level: 'info' }
}

/**
 * High-frequency log lines with no diagnostic value that would otherwise flood
 * Sentry Logs. The dominant case is gramjs/Telegram rate-limit chatter
 * (`Sleeping for Ns on flood wait ...`) — in the Aug 9/10 prod windows it made
 * up ~60-67% of all captured log lines. Each entry is a RegExp tested against
 * the raw message; a match drops the log (returns null from beforeSendLog).
 * Extra patterns can be added via SENTRY_LOG_NOISE_PATTERNS (comma-separated
 * regex sources) and the filter can be disabled entirely with
 * SENTRY_LOG_NOISE_FILTER=false.
 */
const DEFAULT_LOG_NOISE_PATTERNS: RegExp[] = [
  /sleeping for \d+\s*s\s*on flood wait\s*\(caused by messages\./i,
  // GramJS's own `_updateLoop` ping timeout, with its ~15-line stack. It was
  // 10-15% of all production log volume (incident 2026-09-29); the worker
  // aggregates the count into one line per minute instead of reporting each.
  // Left unanchored on purpose: Sentry's log message is the stringified error,
  // not the console prefix. Verified against worker/src — no log of ours
  // contains the literal "Error: TIMEOUT" (our own line reads
  // "[userListener] _updateLoop TIMEOUT for <userId>"), so nothing else is
  // swallowed. `new Error('TIMEOUT')` appears nowhere outside GramJS.
  /Error: TIMEOUT\b/,
]

function compileLogNoisePatterns(env: NodeJS.ProcessEnv): RegExp[] {
  const patterns = [...DEFAULT_LOG_NOISE_PATTERNS]
  const raw = String(env.SENTRY_LOG_NOISE_PATTERNS ?? '').trim()
  if (raw) {
    for (const src of raw.split(',')) {
      const s = src.trim()
      if (!s) continue
      try {
        patterns.push(new RegExp(s, 'i'))
      } catch {
        // Ignore an invalid extra pattern; defaults still apply.
      }
    }
  }
  return patterns
}

let logNoiseEnabled = true
let logNoisePatterns: RegExp[] = [...DEFAULT_LOG_NOISE_PATTERNS]

function beforeSendLog(log: unknown): unknown {
  const safe = safeForSentry(log)
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) return null
  const src = safe as Record<string, unknown>
  const message = src.message
  if (typeof message !== 'string') return null
  if (logNoiseEnabled && logNoisePatterns.some(p => p.test(message))) return null
  const attributes = src.attributes
  return {
    level: src.level ?? 'info',
    message: String(message).slice(0, 512),
    attributes: attributes && typeof attributes === 'object' && !Array.isArray(attributes)
      ? safeForSentry(attributes) as Record<string, unknown>
      : undefined,
  }
}

export function initWorkerSentry(env: NodeJS.ProcessEnv = process.env): void {
  if (initialized) return
  initialized = true
  try {
    if (!envBool(env.SENTRY_ENABLED)) return
    if (envBool(env.LOAD_TEST_MODE) && !envBool(env.SENTRY_LOAD_TEST_ENABLED)) return
    const dsn = String(env.SENTRY_DSN ?? '')
    if (!dsn) return
    if (!isValidSentryDsn(dsn)) {
      warnInvalidDsnOnce()
      return
    }
    logNoiseEnabled = String(env.SENTRY_LOG_NOISE_FILTER ?? '').trim().toLowerCase() !== 'false'
    logNoisePatterns = compileLogNoisePatterns(env)
    sentry.init({
      dsn,
      enabled: true,
      environment: environmentFromEnv(env),
      release: releaseFromEnv(env),
      defaultIntegrations: false,
      integrations: [Sentry.consoleLoggingIntegration()],
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      skipOpenTelemetrySetup: true,
      tracePropagationTargets: [],
      sendDefaultPii: false,
      maxBreadcrumbs: 50,
      enableLogs: true,
      beforeSend: beforeSend as never,
      beforeBreadcrumb: beforeBreadcrumb as never,
      beforeSendLog: beforeSendLog as never,
    })
    enabled = true
    setWorkerGlobalTags(env)
  } catch (err) {
    enabled = false
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[sentry] disabled after initialization failure: ${String(msg).slice(0, 180)}`)
  }
}

export function setWorkerGlobalTags(env: NodeJS.ProcessEnv = process.env): void {
  if (!enabled) return
  try {
    const capability = getBrokerExecutionCapability()
    const tags: Record<string, string> = {
      'worker.role': workerConfig.role,
      'worker.shard_id': String(workerConfig.shardId),
      'worker.shard_count': String(workerConfig.shardCount),
      node_env: String(env.NODE_ENV ?? 'production'),
      'railway.environment': String(env.RAILWAY_ENVIRONMENT_NAME ?? ''),
      broker_mode: capability.broker_mode,
      execution_engine: String(env.EXECUTION_ENGINE ?? 'v1'),
      load_test: envBool(env.LOAD_TEST_MODE) ? 'true' : 'false',
    }
    for (const [key, value] of Object.entries(tags)) sentry.setTag(safeName(key, 'tag'), String(safeForSentry(value)).slice(0, 160))
    sentry.setContext('worker', safeForSentry({
      instance_id: workerConfig.instanceId,
      build_tag: WORKER_BUILD_TAG,
      shard_id: workerConfig.shardId,
      shard_count: workerConfig.shardCount,
      role: workerConfig.role,
    }) as Record<string, unknown>)
  } catch {
    // Sentry must never affect worker startup or execution.
  }
}

function applyScope(scope: unknown, opts: CaptureOptions): void {
  const s = scope as {
    setLevel?: (level: 'fatal' | 'error' | 'warning' | 'info') => void
    setTag?: (key: string, value: string) => void
    setContext?: (key: string, value: Record<string, unknown>) => void
    setFingerprint?: (fingerprint: string[]) => void
    setExtra?: (key: string, value: unknown) => void
  }
  s.setLevel?.(opts.level ?? 'error')
  s.setTag?.('subsystem', safeName(opts.subsystem, 'unknown'))
  s.setTag?.('operation', safeName(opts.operation, 'unknown'))
  const errorCode = opts.errorCode ?? 'UNKNOWN'
  s.setTag?.('error_code', safeName(errorCode, 'UNKNOWN').toUpperCase())
  if (opts.tags) {
    for (const [key, value] of Object.entries(opts.tags)) {
      if (value == null) continue
      s.setTag?.(safeName(key, 'tag'), String(safeForSentry(value)).slice(0, 160))
    }
  }
  s.setContext?.('pipeline', buildSafePipelineContext({
    ...(opts.context ?? {}),
    stage: opts.context?.stage ?? opts.operation,
  }))
  if (opts.extra) s.setExtra?.('safe_extra', safeForSentry(opts.extra))
  s.setFingerprint?.((opts.fingerprint ?? [opts.subsystem, errorCode, opts.operation])
    .slice(0, 5)
    .map(part => safeName(part, 'unknown')))
}

export function captureWorkerError(err: unknown, opts: CaptureOptions): void {
  if (!enabled) return
  try {
    const errorCode = opts.errorCode ?? normalizedErrorCode(err)
    sentry.withScope(scope => {
      applyScope(scope, { ...opts, level: 'error', errorCode })
      sentry.captureException(err instanceof Error ? err : new Error(String(err ?? 'unknown error')))
    })
  } catch {
    // Capture failures must not alter trade outcomes.
  }
}

export function captureWorkerWarning(messageOrError: unknown, opts: CaptureOptions): void {
  if (!enabled) return
  try {
    const errorCode = opts.errorCode ?? normalizedErrorCode(messageOrError, 'WARNING')
    sentry.withScope(scope => {
      applyScope(scope, { ...opts, level: 'warning', errorCode })
      if (messageOrError instanceof Error) sentry.captureException(messageOrError)
      else sentry.captureMessage(String(safeForSentry(String(messageOrError ?? 'warning'))), 'warning')
    })
  } catch {
    // best-effort only
  }
}

export function captureWorkerMessage(message: string, opts: CaptureOptions): void {
  if (!enabled) return
  try {
    const errorCode = opts.errorCode ?? 'MESSAGE'
    sentry.withScope(scope => {
      applyScope(scope, { ...opts, errorCode })
      sentry.captureMessage(String(safeForSentry(message)).slice(0, 240), opts.level ?? 'warning')
    })
  } catch {
    // best-effort only
  }
}

export function captureWorkerCheckIn(
  checkIn: Parameters<typeof Sentry.captureCheckIn>[0],
  monitorConfig?: Parameters<typeof Sentry.captureCheckIn>[1],
): string | null {
  if (!enabled) return null
  try {
    return sentry.captureCheckIn(checkIn, monitorConfig) ?? null
  } catch {
    return null
  }
}

export type WorkerLogLevel = 'info' | 'warn' | 'error'

export function captureWorkerLog(
  level: WorkerLogLevel,
  message: string,
  opts: CaptureOptions & { attributes?: Record<string, unknown> },
): void {
  if (!enabled) return
  try {
    const attributes: Record<string, unknown> = {
      subsystem: safeName(opts.subsystem, 'unknown'),
      operation: safeName(opts.operation, 'unknown'),
    }
    if (opts.errorCode) attributes.error_code = safeName(opts.errorCode, 'UNKNOWN').toUpperCase()
    const tags = sanitizeTags(opts.tags)
    if (tags) Object.assign(attributes, tags)
    if (opts.attributes && typeof opts.attributes === 'object' && !Array.isArray(opts.attributes)) {
      const safeAttributes = safeForSentry(opts.attributes)
      if (safeAttributes && typeof safeAttributes === 'object' && !Array.isArray(safeAttributes)) {
        Object.assign(attributes, safeAttributes as Record<string, unknown>)
      }
    }
    const safeMessage = String(safeForSentry(message)).slice(0, 512)
    const log = sentry.logger
    if (level === 'info') log.info(safeMessage, attributes)
    else if (level === 'warn') log.warn(safeMessage, attributes)
    else log.error(safeMessage, attributes)
  } catch {
    // best-effort only
  }
}

export function addWorkerBreadcrumb(args: {
  category: string
  message?: string
  level?: 'debug' | 'info' | 'warning' | 'error'
  data?: Record<string, unknown>
}): void {
  if (!enabled) return
  try {
    sentry.addBreadcrumb(beforeBreadcrumb({
      category: args.category,
      message: args.message,
      level: args.level ?? 'info',
      data: args.data,
    }) as Parameters<SentryAdapter['addBreadcrumb']>[0])
  } catch {
    // best-effort only
  }
}

export async function flushWorkerSentry(timeoutMs = 1800): Promise<boolean> {
  if (!enabled) return false
  try {
    return await sentry.flush(Math.max(0, Math.min(2_000, timeoutMs)))
  } catch {
    return false
  }
}

function rejectionToError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'unhandled rejection'))
}

export function captureWorkerFatalError(err: unknown, opts: CaptureOptions): boolean {
  const objectErr = err && typeof err === 'object' ? err as object : null
  if (objectErr && fatalErrors.has(objectErr)) return false
  const signature = [
    opts.subsystem,
    opts.operation,
    opts.errorCode ?? normalizedErrorCode(err),
    err instanceof Error ? err.name : typeof err,
    err instanceof Error ? err.message : String(err ?? ''),
  ].join('|')
  const now = Date.now()
  const previous = fatalSignatures.get(signature) ?? 0
  if (now - previous < 2_000) return false
  if (objectErr) fatalErrors.add(objectErr)
  fatalSignatures.set(signature, now)
  captureWorkerError(err, opts)
  return true
}

/** Print a visible, redacted fatal-error line to stdout before the silent exit,
 * so deaths are never invisible in Railway logs even if Sentry ingest is down. */
function logFatalToConsole(code: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err
  const message = typeof err === 'string'
    ? err
    : err instanceof Error ? (err.message || '') : String(err ?? '')
  const safe = safeForSentry({ code, name, message })
  const { code: c, name: n, message: m } = safe as { code?: string; name?: string; message?: string }
  console.error(
    `[worker-fatal] ${c ?? 'UNKNOWN'} ${n ?? 'Error'}: ${m ?? '[no message]'}`,
  )
}

export function handleWorkerUncaughtException(err: Error): void {
  if (fatalCaptureInFlight) {
    logFatalToConsole('UNCAUGHT_EXCEPTION', err)
    process.exit(1)
    return
  }
  fatalCaptureInFlight = true
  logFatalToConsole('UNCAUGHT_EXCEPTION', err)
  captureWorkerFatalError(err, {
    subsystem: 'worker',
    operation: 'uncaught_exception',
    errorCode: 'UNCAUGHT_EXCEPTION',
    fingerprint: ['worker', 'UNCAUGHT_EXCEPTION', err.name || 'Error'],
  })
  void flushWorkerSentry(1800).finally(() => process.exit(1))
}

export function handleWorkerUnhandledRejection(reason: unknown): void {
  if (fatalCaptureInFlight) return
  fatalCaptureInFlight = true
  const err = rejectionToError(reason)
  logFatalToConsole('UNHANDLED_REJECTION', err)
  captureWorkerFatalError(err, {
    subsystem: 'worker',
    operation: 'unhandled_rejection',
    errorCode: 'UNHANDLED_REJECTION',
    fingerprint: ['worker', 'UNHANDLED_REJECTION', err.name || 'Error'],
  })
  void flushWorkerSentry(1800).finally(() => process.exit(1))
}

export function installWorkerProcessSentryHandlers(): void {
  if (processHandlersInstalled) return
  processHandlersInstalled = true
  uncaughtHandler = err => handleWorkerUncaughtException(err)
  rejectionHandler = reason => handleWorkerUnhandledRejection(reason)
  process.on('uncaughtException', uncaughtHandler)
  process.on('unhandledRejection', rejectionHandler)
}

export function removeWorkerProcessSentryHandlersForTests(): void {
  if (uncaughtHandler) process.off('uncaughtException', uncaughtHandler)
  if (rejectionHandler) process.off('unhandledRejection', rejectionHandler)
  uncaughtHandler = null
  rejectionHandler = null
  processHandlersInstalled = false
}

export { safeForSentry, buildSafePipelineContext }
