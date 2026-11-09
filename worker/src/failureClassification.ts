/**
 * Failure classification shared by the monitors.
 *
 * A retry cannot fix these, so the caller must back off hard instead of
 * re-driving the same broker call every tick:
 *   - the stored ticket maps to no (or to several) live positions;
 *   - the identity lookup is ambiguous;
 *   - the failure is already framed as needing reconciliation.
 * Everything else is treated as transient and retried soon.
 *
 * Lives in its own module (rather than inside a monitor) so monitors can
 * import it without forming a module cycle between them.
 *
 * Keep the phrase list aligned with `supabase/functions/_shared/alertEvalRules.ts`
 * (`isReconcileDriftRow`) — the alert-evaluator uses the same phrases to keep
 * these rows out of the executions_failing counts. Literal sharing is
 * impossible: Supabase bundles only `supabase/functions/` and cannot import
 * `worker/src/`. The alert side adds the `Reconcile:` prefix
 * (`Reconcile: 1/1 legs; broker SL still drifted`).
 */
export function isUnresolvableFailure(message: string | null | undefined): boolean {
  const m = String(message ?? '').toLowerCase()
  return m.includes('no live position match')
    || m.includes('maps to multiple live positions')
    || m.includes('attributes match multiple live positions')
    || m.includes('reconciliation required')
    || m.includes('identity ambiguous')
}

/**
 * Identity-resolution reasons that mean the trade row's own position is NOT
 * present in the live OpenedOrders snapshot: the stored ticket matched
 * nothing, so `resolveCanonicalOpenPosition` fell through to attribute
 * matching (and either found no candidate or several identical siblings —
 * in the multi case it refuses to guess, correctly).
 *
 * Management (auto-breakeven, channel breakeven/close) must not record these
 * as failed modifications: there is nothing to modify, a retry cannot change
 * the snapshot, and only reconciliation may confirm closure (two snapshots +
 * closed-history proof before the row is closed — 2026-10-06 design).
 * 2026-11-03, Luis: four star-fx legs whose positions had already exited kept
 * writing customer-facing `auto_be` failures while identical siblings were
 * still open; the rows were closed by reconciliation minutes later.
 *
 * Deliberately NOT included:
 *   - `identity match is by attributes only; not persisted` — that resolves to
 *     a LIVE position we refuse to touch (a real protection gap, must stay loud);
 *   - `OpenedOrders response is not a complete list` / `stored ticket is
 *     invalid` / `stored ticket maps to multiple live positions` — data or
 *     read problems that need review, not a silent defer.
 */
export function isLivePositionAbsentReason(reason: string | null | undefined): boolean {
  const m = String(reason ?? '').toLowerCase()
  return m.includes('stored ticket has no live position match')
    || m.includes('attributes match multiple live positions')
}
