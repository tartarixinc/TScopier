import { workerConfig } from '../workerConfig'
import { captureCriticalHealthIssue, hashHealthResourceId } from './criticalHealth'

const DEFAULT_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_MIN_ATTEMPTS = 10
const DEFAULT_FAILURE_THRESHOLD_PCT = 50
const MAX_HISTORY = 500

/**
 * Error codes that represent per-account configuration issues, not system
 * failures. These must not count toward the systemic failure threshold —
 * a single user's broker not offering gold should not page the team.
 */
const CONFIG_ERROR_CODES = new Set([
  'BROKER_SYMBOL_NOT_FOUND',
  'SYMBOL_UNSUPPORTED',
])

type ExecutionRecord = {
  timestamp: number
  success: boolean
  errorCode?: string
  brokerId: string
}

export interface TradeExecutionMonitorOptions {
  windowMs?: number
  minAttempts?: number
  failureThresholdPct?: number
  enabled?: boolean
  onAlert?: () => void
  nowMs?: () => number
}

export interface TradeOutcomeLike {
  openedOrMerged?: boolean
  finalizeSkipReason?: string
  failureReason?: string
}

/**
 * Classify a trade outcome for the pipeline monitor. Returns true for a genuine
 * success (order opened/merged) and for a deterministic no-op (finalizeSkipReason
 * without a failureReason) — the latter is an expected business outcome, not a
 * failed execution, so it must not inflate the failure denominator.
 */
export function tradeOutcomeIsSuccess(outcome: TradeOutcomeLike): boolean {
  if (outcome.failureReason) return false
  if (outcome.openedOrMerged === true) return true
  return !!outcome.finalizeSkipReason
}

export class TradeExecutionMonitor {
  private readonly windowMs: number
  private readonly minAttempts: number
  private readonly failureThresholdPct: number
  private readonly enabled: boolean
  private readonly onAlert: () => void
  private readonly nowMs: () => number
  private history: ExecutionRecord[] = []
  private alertEmitted = false

  constructor(opts: TradeExecutionMonitorOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.minAttempts = opts.minAttempts ?? DEFAULT_MIN_ATTEMPTS
    this.failureThresholdPct = opts.failureThresholdPct ?? DEFAULT_FAILURE_THRESHOLD_PCT
    this.enabled = opts.enabled ?? true
    this.onAlert = opts.onAlert ?? (() => {})
    this.nowMs = opts.nowMs ?? (() => Date.now())
  }

  recordExecution(success: boolean, brokerId: string, errorCode?: string): void {
    if (!this.enabled) return

    const now = this.nowMs()
    this.history.push({
      timestamp: now,
      success,
      errorCode,
      brokerId,
    })

    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY)
    }

    this.pruneOldRecords(now)
    this.checkAndAlert(now)
  }

  private pruneOldRecords(now: number): void {
    const cutoff = now - this.windowMs
    this.history = this.history.filter(r => r.timestamp >= cutoff)
  }

  private checkAndAlert(now: number): void {
    if (!this.enabled) return

    const windowStart = now - this.windowMs
    const windowRecords = this.history.filter(r => r.timestamp >= windowStart)

    // Re-arm on recovery: once the window has enough executions again and the
    // failure rate drops below the threshold, a later spike can alert again.
    // captureCriticalHealthIssue's own cooldown still prevents alert storms.
    if (this.alertEmitted && windowRecords.length >= this.minAttempts) {
      const systemFailures = windowRecords.filter(r => !r.success && !CONFIG_ERROR_CODES.has(r.errorCode ?? '')).length
      const failureRatePct = (systemFailures / windowRecords.length) * 100
      if (failureRatePct < this.failureThresholdPct) {
        this.alertEmitted = false
      }
    }

    if (this.alertEmitted) return
    if (windowRecords.length < this.minAttempts) return

    const systemFailures = windowRecords.filter(r => !r.success && !CONFIG_ERROR_CODES.has(r.errorCode ?? '')).length
    const failureRatePct = (systemFailures / windowRecords.length) * 100

    if (failureRatePct >= this.failureThresholdPct) {
      this.alertEmitted = true
      this.emitAlert(systemFailures, windowRecords.length, failureRatePct, now)
    }
  }

  private emitAlert(
    failures: number,
    total: number,
    failureRatePct: number,
    now: number
  ): void {
    const windowStart = now - this.windowMs
    const errorCodes = Array.from(
      new Set(this.history.filter(r => r.timestamp >= now - this.windowMs && !r.success).map(r => r.errorCode).filter(Boolean))
    )
    const affectedBrokers = Array.from(
      new Set(this.history.filter(r => r.timestamp >= now - this.windowMs && !r.success).map(r => r.brokerId))
    )

    captureCriticalHealthIssue({
      component: 'trade_pipeline',
      failureClass: 'systemic_failure',
      state: 'unavailable',
      severity: 'critical',
      reasonCode: 'TRADE_PIPELINE_SYSTEMIC_FAILURE',
      message: 'critical_health.trade_pipeline.systemic_failure',
      fingerprint: ['critical_health', 'trade_pipeline', 'systemic_failure'],
      dedupeKey: 'trade_pipeline|systemic_failure|system|unavailable',
      metadata: {
        failure_rate_pct: Math.round(failureRatePct),
        window_ms: this.windowMs,
        total_attempts: total,
        failures,
        successes: total - failures,
        affected_accounts: affectedBrokers.map(id => `acct_${hashHealthResourceId(id)}`),
        common_error_codes: errorCodes,
        window_start_at: new Date(windowStart).toISOString(),
        window_end_at: new Date(now).toISOString(),
        worker_instance_id: workerConfig.instanceId,
        worker_role: workerConfig.role,
        worker_shard_id: workerConfig.shardId,
      },
    })

    this.onAlert()
  }

  reset(): void {
    this.history = []
    this.alertEmitted = false
  }

  getStats(): { total: number; failures: number; successRate: number; windowMs: number } {
    const now = this.nowMs()
    this.pruneOldRecords(now)
    const total = this.history.length
    const failures = this.history.filter(r => !r.success).length
    return {
      total,
      failures,
      successRate: total > 0 ? (total - failures) / total : 1,
      windowMs: this.windowMs,
    }
  }
}

let monitorSingleton: TradeExecutionMonitor | null = null

function envNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

export function getTradeExecutionMonitor(opts?: TradeExecutionMonitorOptions): TradeExecutionMonitor {
  if (monitorSingleton) return monitorSingleton

  const windowMs = envNumber(process.env.TRADE_PIPELINE_WINDOW_MS, DEFAULT_WINDOW_MS, 1_000, 24 * 60 * 60 * 1000)
  const minAttempts = envNumber(process.env.TRADE_PIPELINE_MIN_ATTEMPTS, DEFAULT_MIN_ATTEMPTS, 1, 100_000)
  const failureThresholdPct = envNumber(process.env.TRADE_PIPELINE_FAILURE_THRESHOLD_PCT, DEFAULT_FAILURE_THRESHOLD_PCT, 1, 100)

  monitorSingleton = new TradeExecutionMonitor({
    windowMs,
    minAttempts,
    failureThresholdPct,
    enabled: true,
  })
  return monitorSingleton
}

export function resetTradeExecutionMonitorForTests(): void {
  if (monitorSingleton) {
    monitorSingleton.reset()
    monitorSingleton = null
  }
}
