import { captureWorkerMessage, addWorkerBreadcrumb, isWorkerSentryEnabled } from './sentry'
import { isTradingDisabledMessage } from '../brokerTradeError'
import { safeForSentry } from './sentryRedaction'
import type { WorkerSentryContextInput } from './sentryContext'

export type BusinessEventCategory =
  | 'trade'
  | 'broker'
  | 'telegram'
  | 'copier'
  | 'account'
  | 'queue'
  | 'persistence'
  | 'layering'
  | 'management'
  | 'reconciliation'
  | 'auth'
  | 'worker'

export type BusinessSeverity = 'info' | 'warning' | 'error' | 'fatal'
export type UserImpact = 'none' | 'delayed' | 'skipped' | 'partial' | 'failed' | 'manual_review_required'

type BusinessContext = WorkerSentryContextInput & {
  broker_provider?: string | null
  reason_code?: string | null
  operation?: string | null
  user_impact?: UserImpact | null
}

export type BusinessIssueInput = {
  category: BusinessEventCategory
  event: string
  severity: BusinessSeverity
  reasonCode: string
  message: string
  context?: BusinessContext
  dedupeKey?: string
  fingerprint?: string[]
  userImpact: UserImpact
}

export type BusinessBreadcrumbInput = {
  category: BusinessEventCategory
  event: string
  level?: 'debug' | 'info' | 'warning' | 'error'
  context?: BusinessContext
}

const DEFAULT_COOLDOWN_MS = 5 * 60_000
const MAX_DEDUPE_KEYS = 500
const EVENT_NAME_RE = /^[a-z][a-z0-9_]{2,80}$/
const REASON_CODE_RE = /^[A-Z][A-Z0-9_]{2,80}$/
const suppressedUntil = new Map<string, number>()

function envBool(raw: string | undefined, fallback: boolean): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function cooldownMs(): number {
  const parsed = Number(process.env.SENTRY_BUSINESS_EVENT_COOLDOWN_MS)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_COOLDOWN_MS
  return Math.min(parsed, 60 * 60_000)
}

function enabled(): boolean {
  return isWorkerSentryEnabled()
    && envBool(process.env.SENTRY_BUSINESS_EVENTS_ENABLED, true)
}

function stableEventName(value: string): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  return EVENT_NAME_RE.test(normalized) ? normalized : 'business_issue'
}

function stableReasonCode(value: string): string {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  return REASON_CODE_RE.test(normalized) ? normalized : 'UNKNOWN'
}

function boundedContext(input: BusinessContext | undefined, reasonCode: string, userImpact: UserImpact): WorkerSentryContextInput {
  const extraSrc = input?.extra ?? {}
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(extraSrc).slice(0, 30)) {
    extra[key] = value
  }
  return {
    ...(input ?? {}),
    operation: input?.operation ?? input?.stage ?? null,
    extra: safeForSentry({
      ...extra,
      reason_code: reasonCode,
      user_impact: userImpact,
      broker_provider: input?.broker_provider ?? null,
    }) as Record<string, unknown>,
  }
}

function fingerprintFor(args: {
  category: BusinessEventCategory
  event: string
  reasonCode: string
  context?: BusinessContext
  fingerprint?: string[]
}): string[] {
  const requested = args.fingerprint ?? [
    args.event,
    args.context?.operation ?? args.context?.stage ?? args.category,
    args.reasonCode,
    args.context?.broker_provider ?? null,
    args.context?.execution_mechanism ?? null,
  ]
  return requested
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map(part => part
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, '_')
      .slice(0, 80))
    .slice(0, 5)
}

function suppressionKey(args: {
  category: BusinessEventCategory
  event: string
  reasonCode: string
  context?: BusinessContext
  dedupeKey?: string
}): string {
  return [
    args.category,
    args.event,
    args.reasonCode,
    args.context?.operation ?? args.context?.stage ?? '',
    args.context?.broker_provider ?? '',
    args.context?.execution_mechanism ?? '',
    args.dedupeKey ?? '',
  ].join('|')
}

function shouldSuppress(args: BusinessIssueInput, event: string, reasonCode: string): boolean {
  if (args.userImpact === 'manual_review_required' || args.severity === 'fatal') return false
  const key = suppressionKey({ ...args, event, reasonCode })
  const now = Date.now()
  const until = suppressedUntil.get(key) ?? 0
  if (until > now) return true
  if (suppressedUntil.size >= MAX_DEDUPE_KEYS) {
    const oldest = suppressedUntil.keys().next().value as string | undefined
    if (oldest) suppressedUntil.delete(oldest)
  }
  suppressedUntil.set(key, now + cooldownMs())
  return false
}

export function resetBusinessEventsForTests(): void {
  suppressedUntil.clear()
}

export function captureBusinessIssue(args: BusinessIssueInput): void {
  try {
    if (!enabled()) return
    const event = stableEventName(args.event)
    const reasonCode = stableReasonCode(args.reasonCode)
    if (shouldSuppress(args, event, reasonCode)) return
    const context = boundedContext(args.context, reasonCode, args.userImpact)
    const message = `${event}: ${String(safeForSentry(args.message)).slice(0, 180)}`
    captureWorkerMessage(message, {
      subsystem: args.category,
      operation: context.operation ?? event,
      level: args.severity,
      errorCode: reasonCode,
      fingerprint: fingerprintFor({ ...args, event, reasonCode }),
      context,
      tags: {
        event_category: args.category,
        event_name: event,
        reason_code: reasonCode,
        user_impact: args.userImpact,
      },
    })
  } catch {
    // Business observability must never affect worker behavior.
  }
}

export function addBusinessBreadcrumb(args: BusinessBreadcrumbInput): void {
  try {
    if (!enabled()) return
    const event = stableEventName(args.event)
    addWorkerBreadcrumb({
      category: args.category,
      message: event,
      level: args.level ?? 'info',
      data: boundedContext(args.context, args.context?.reason_code ?? 'BREADCRUMB', args.context?.user_impact ?? 'none'),
    })
  } catch {
    // best-effort only
  }
}

export function classifyBrokerFailureReason(message: string): string {
  const lower = String(message ?? '').toLowerCase()
  if (/margin|not enough money|insufficient funds/.test(lower)) return 'INSUFFICIENT_MARGIN'
  if (isTradingDisabledMessage(lower)) {
    return 'BROKER_SYMBOL_TRADE_DISABLED'
  }
  if (/market.*closed|off quotes|trade disabled/.test(lower)) return 'MARKET_CLOSED'
  if (/invalid volume|lot|minimum volume|min lot/.test(lower)) return 'INVALID_LOT'
  if (
    /symbolselect/.test(lower)
    || (/symbol|instrument/.test(lower) && /not found|unknown|unsupported|invalid|select\s*failed/.test(lower))
  ) {
    return 'BROKER_SYMBOL_NOT_FOUND'
  }
  if (/timeout|timed out|operation timeout/.test(lower)) return 'BROKER_TIMEOUT'
  if (/not connected|disconnected|session|auth|unauthorized|forbidden|invalid api/.test(lower)) return 'BROKER_ACCOUNT_UNAVAILABLE'
  if (/rate limit|too many requests/.test(lower)) return 'BROKER_RATE_LIMITED'
  return 'BROKER_ORDER_REJECTED'
}
