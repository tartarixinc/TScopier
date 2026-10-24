/**
 * Pending-order cancellation.
 *
 * A resting pending order is not a position, and the two transports treat its
 * removal differently:
 *   - FXSocket: `POST /OrderClose` doubles as the pending cancel.
 *   - MTAPI:    `OrderCloseSafe` rejects several pendings with `Invalid request`
 *               while the order survives (prod 2026-10-23: order 387155920 on
 *               MT5 • 196509025 was retried every 5 minutes for 215 failures in
 *               24 hours). The bridge documents `GET /OrderCancelTask` as the
 *               pending-cancel endpoint (`docs/mtapi-migration-plan.md`).
 *
 * Callers (the pending TTL sweep, signal-entry pending cancel, basket cleanup)
 * share this helper so the endpoint choice and the retry backoff live in one
 * place instead of being re-invented per call site.
 */

export type PendingCancelApi = {
  orderClose(id: string, args: { ticket: number }): Promise<unknown>
  /** Provider-native pending cancel. Absent on older/simulated providers. */
  orderCancel?(id: string, args: { ticket: number }): Promise<unknown>
}

/** Cancel a resting pending order, preferring the provider's cancel endpoint. */
export async function cancelPendingOrderAtBroker(
  api: PendingCancelApi,
  sessionId: string,
  ticket: number,
): Promise<void> {
  if (typeof api.orderCancel === 'function') {
    await api.orderCancel(sessionId, { ticket })
    return
  }
  await api.orderClose(sessionId, { ticket })
}

export type PendingCancelBackoffOptions = {
  /** Failures tolerated before the ticket is put into backoff. Default 3. */
  maxAttempts?: number
  /** Backoff duration after `maxAttempts` failures. Default 60 minutes. */
  backoffMs?: number
  /** Spacing between the first attempts (one sweep cycle). Default 5 minutes. */
  cycleMs?: number
  now?: () => number
}

type PendingCancelState = {
  attempts: number
  nextAttemptAt: number
  escalated: boolean
}

/**
 * Per-ticket retry governor for the pending-cancel sweeps.
 *
 * Without it a single stubborn broker pending produces one failed close every
 * sweep cycle for as long as the order lives — each failure also writing an
 * `order_close_audit` row, which is what pushed `executions_failing` over its
 * threshold. After `maxAttempts` failures a ticket sleeps for `backoffMs` and
 * the caller is told once (return value of `recordFailure`) to write a single
 * escalation row, instead of one failure row per cycle.
 */
export class PendingCancelBackoff {
  private readonly state = new Map<string, PendingCancelState>()
  private readonly maxAttempts: number
  private readonly backoffMs: number
  private readonly cycleMs: number
  private readonly now: () => number

  constructor(opts: PendingCancelBackoffOptions = {}) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
    this.backoffMs = Math.max(0, opts.backoffMs ?? 60 * 60_000)
    this.cycleMs = Math.max(0, opts.cycleMs ?? 5 * 60_000)
    this.now = opts.now ?? Date.now
  }

  /** False while a failed ticket is inside its backoff window. */
  shouldAttempt(key: string): boolean {
    const entry = this.state.get(key)
    if (!entry) return true
    return this.now() >= entry.nextAttemptAt
  }

  /**
   * Record a failed attempt. Returns true exactly once per failure series —
   * the caller should emit one escalation log for it.
   */
  recordFailure(key: string): boolean {
    const now = this.now()
    const entry = this.state.get(key) ?? { attempts: 0, nextAttemptAt: 0, escalated: false }
    entry.attempts += 1
    if (entry.attempts < this.maxAttempts) {
      entry.nextAttemptAt = now + this.cycleMs
      this.state.set(key, entry)
      return false
    }
    entry.nextAttemptAt = now + this.backoffMs
    const escalate = !entry.escalated
    entry.escalated = true
    this.state.set(key, entry)
    return escalate
  }

  /** A successful cancel ends the series and frees the key. */
  recordSuccess(key: string): void {
    this.state.delete(key)
  }

  /** Attempts recorded for a key (0 when unknown). */
  attemptsFor(key: string): number {
    return this.state.get(key)?.attempts ?? 0
  }

  reset(): void {
    this.state.clear()
  }
}
