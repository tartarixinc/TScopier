// alertEvalRules — pure helpers for alert-evaluator tuning (2026-11-02 audit).
// Kept side-effect free so they can be unit-tested without importing the
// evaluator (which starts an HTTP server on import).

/**
 * Reconciliation/drift rows are diagnostic bookkeeping: the management layer
 * reporting that broker state differs from what it wanted (SL drifted, stored
 * ticket has no live position, ambiguous position identity). They are retried
 * every cycle by design, so one stuck position can write dozens of rows per
 * hour. Counting them as "failed executions" made executions_failing page on
 * internal bookkeeping noise (2026-10-27: 194 of 278 failed rows were this
 * class). Same reasoning as the existing `order_close_audit` exclusion.
 *
 * Keep the phrase list aligned with `worker/src/failureClassification.ts`
 * (`isUnresolvableFailure`) — the worker uses it to decide "do not retry",
 * this uses it to decide "do not count". Literal sharing is impossible:
 * Supabase bundles only `supabase/functions/` and cannot import `worker/src/`.
 * This predicate adds the worker's phrases plus the `Reconcile:` prefix
 * (`Reconcile: 1/1 legs; broker SL still drifted`).
 */
export function isReconcileDriftRow(errorMessage: string | null | undefined): boolean {
  const e = String(errorMessage ?? "").toLowerCase();
  return e.startsWith("reconcile:")
    || e.includes("reconciliation required")
    || e.includes("no live position match")
    || e.includes("maps to multiple live positions")
    || e.includes("attributes match multiple live positions")
    || e.includes("identity ambiguous");
}

/**
 * Users whose Telegram session must be re-linked by the owner (revoked or
 * invalidated session, `telegram_account_status = 'reconnect_required'`).
 * They cannot be copied until the user acts, and the product UI already shows
 * "Reconnect required" on their dashboard — a user-action problem, not a
 * copier outage. Excluded from the telegram_gap scope: otherwise a permanent
 * pair of them sits exactly at the alert threshold (max_not_listening = 2)
 * and any one-minute heartbeat blip elsewhere pages (2026-11-02 audit).
 */
export function reconnectRequiredUserIds(
  rows: Array<{ user_id: string; telegram_account_status?: string | null }>,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (String(row.telegram_account_status ?? "").toLowerCase() !== "reconnect_required") continue;
    const id = String(row.user_id ?? "").trim();
    if (id) out.add(id);
  }
  return out;
}

export interface PersistenceInput {
  /** Required hold time in ms; <= 0 disables persistence (legacy behaviour). */
  persistMs: number;
  /** Condition currently holds (rule outcome.fired). */
  fired: boolean;
  /** An open (firing/acknowledged) event exists for this rule. */
  hasOpen: boolean;
  /** When the condition continuously started holding (epoch ms), null = not armed. */
  trueSince: number | null;
  /** When the condition continuously cleared while an event was open (epoch ms). */
  falseSince: number | null;
  nowMs: number;
}

export interface PersistenceStep {
  /**
   * insert  — open an event now (caller still applies the cooldown check)
   * resolve — close the open event now
   * none    — hold; patch may still need writing to arm/keep/clear state
   */
  action: "none" | "insert" | "resolve";
  /**
   * State to write on alert_rules. Absent key = leave the column untouched,
   * null = clear the column. Epoch ms. The caller applies the patch ONLY when
   * it actually performed the action (or on "none" to arm/reset), so a failed
   * insert never loses the armed timestamp.
   */
  patch: { cond_true_since?: number | null; cond_false_since?: number | null };
}

/**
 * Persistence state machine: fire only after the condition has held for
 * `persistMs`, resolve only after it has cleared for `persistMs`. Kills
 * one-tick blips in both directions (2026-11-02 audit: telegram_gap fired 47
 * times in 5 days, almost all 1-minute episodes). With persistMs <= 0 the
 * behaviour is exactly the original immediate fire/resolve.
 */
export function persistenceStep(input: PersistenceInput): PersistenceStep {
  const { persistMs, fired, hasOpen, trueSince, falseSince, nowMs } = input;

  if (persistMs <= 0) {
    // Legacy immediate behaviour. If persistence was just switched off while a
    // timer was armed (operator edited threshold.persistence_minutes 2 -> 0),
    // clear the stale timers so re-enabling later cannot fire without a hold.
    const stale = trueSince != null || falseSince != null;
    const clear = stale ? { cond_true_since: null, cond_false_since: null } : {};
    if (fired && !hasOpen) return { action: "insert", patch: clear };
    if (!fired && hasOpen) return { action: "resolve", patch: clear };
    if (stale) return { action: "none", patch: clear };
    return { action: "none", patch: {} };
  }

  if (fired) {
    if (hasOpen) {
      // Event already open: a re-true condition cancels any pending resolve.
      return { action: "none", patch: falseSince != null ? { cond_false_since: null } : {} };
    }
    const since = trueSince ?? nowMs;
    if (nowMs - since >= persistMs) {
      return { action: "insert", patch: { cond_true_since: null, cond_false_since: null } };
    }
    // First true tick arms; later true ticks keep the timer.
    return { action: "none", patch: trueSince == null ? { cond_true_since: nowMs } : {} };
  }

  if (hasOpen) {
    const since = falseSince ?? nowMs;
    if (nowMs - since >= persistMs) {
      return { action: "resolve", patch: { cond_true_since: null, cond_false_since: null } };
    }
    // First false tick arms the resolve timer; the event stays open.
    return { action: "none", patch: falseSince == null ? { cond_false_since: nowMs } : {} };
  }

  // Clear with nothing open: drop any stale timers so a later episode starts fresh.
  if (trueSince != null || falseSince != null) {
    return { action: "none", patch: { cond_true_since: null, cond_false_since: null } };
  }
  return { action: "none", patch: {} };
}

// --- Severity escalation + email gating (2026-11-13 audit).

/** Severity ordering used by the recipient filter and escalation tiers. */
export const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

export interface EscalationTier {
  after_minutes: number;
  severity: string;
}

/**
 * Highest escalation tier whose hold time has elapsed AND whose severity is
 * above the event's current one — null when nothing applies. Severity only
 * ever moves up, so each tier applies at most once per event.
 */
export function nextEscalation(
  tiers: unknown,
  currentSeverity: string,
  openCreatedAtIso: string,
  nowMs: number,
): EscalationTier | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const openMs = Date.parse(openCreatedAtIso);
  if (!Number.isFinite(openMs)) return null;
  const elapsedMs = nowMs - openMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  let bestRank = SEVERITY_RANK[currentSeverity] ?? 1;
  let best: EscalationTier | null = null;
  for (const raw of tiers) {
    if (raw === null || typeof raw !== "object") continue;
    const t = raw as { after_minutes?: unknown; severity?: unknown };
    const minutes = Number(t.after_minutes);
    const severity = String(t.severity ?? "");
    const rank = SEVERITY_RANK[severity];
    if (!Number.isFinite(minutes) || minutes < 0 || rank === undefined) continue;
    if (rank <= bestRank) continue;
    if (elapsedMs < minutes * 60_000) continue;
    best = { after_minutes: minutes, severity };
    bestRank = rank;
  }
  return best;
}

/**
 * Option B (2026-11-13 audit): never send a "recovered" email for a page that
 * never went out — mark the row handled instead (sub-minute blips that
 * resolved before their first send, and warning-level events no recipient is
 * eligible for). A missing stamping column (migration not applied) keeps the
 * legacy send-always behaviour.
 */
export function shouldSuppressRecovery(
  kind: "firing" | "resolved" | "escalated",
  firingEmailSentAt: string | null | undefined,
  columnsAvailable: boolean,
): boolean {
  if (kind !== "resolved" || !columnsAvailable) return false;
  return firingEmailSentAt == null || firingEmailSentAt === "";
}
