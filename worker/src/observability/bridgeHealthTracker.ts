/*
 * Bridge outage state machine — extracted from MtapiSessionManager so the
 * session manager's provision/health failures and the standalone bridge probe
 * (bridgeProbe.ts) share ONE tracker: Sentry and the probe tables can never
 * disagree about whether the bridge is down.
 *
 * Behaviour is unchanged from the original private methods: after a
 * continuous run of failures longer than the grace period (default 120s),
 * raise exactly one Sentry critical-health issue; any success resets.
 */

import { captureCriticalHealthIssue } from './criticalHealth'
import { addWorkerBreadcrumb } from './sentry'

export interface BridgeHealthTrackerOptions {
  /** Grace period before a sustained failure raises a Sentry issue. */
  graceMs: () => number
}

export class BridgeHealthTracker {
  /** Start of the current run of bridge-level failures. */
  private outageStartedAtMs: number | null = null
  private alertSent = false

  constructor(private readonly options: BridgeHealthTrackerOptions) {}

  noteFailure(): void {
    const now = Date.now()
    if (this.outageStartedAtMs == null) this.outageStartedAtMs = now
    if (this.alertSent) return
    if (now - this.outageStartedAtMs < this.options.graceMs()) return
    this.alertSent = true
    captureCriticalHealthIssue({
      component: 'broker_rpc',
      failureClass: 'sustained_outage',
      provider: 'mtapi',
      state: 'unavailable',
      severity: 'critical',
      reasonCode: 'MTAPI_BRIDGE_UNAVAILABLE',
      message: 'mtapi_bridge_unavailable',
      fingerprint: ['critical_health', 'broker_rpc', 'mtapi', 'bridge_unavailable'],
      dedupeKey: 'critical_health|broker_rpc|mtapi|bridge_unavailable',
      metadata: { duration_ms: now - this.outageStartedAtMs },
    })
  }

  noteSuccess(): void {
    if (this.outageStartedAtMs != null && this.alertSent) {
      addWorkerBreadcrumb({
        category: 'worker',
        level: 'info',
        message: 'MTAPI bridge recovered',
        data: { duration_ms: Math.max(0, Date.now() - this.outageStartedAtMs) },
      })
    }
    this.outageStartedAtMs = null
    this.alertSent = false
  }

  /** For tests and diagnostics. */
  outageStartedAt(): number | null {
    return this.outageStartedAtMs
  }

  /** For tests and diagnostics. */
  sustainedAlertSent(): boolean {
    return this.alertSent
  }
}
