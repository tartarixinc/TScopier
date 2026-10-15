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
 */
export function isUnresolvableFailure(message: string | null | undefined): boolean {
  const m = String(message ?? '').toLowerCase()
  return m.includes('no live position match')
    || m.includes('maps to multiple live positions')
    || m.includes('attributes match multiple live positions')
    || m.includes('reconciliation required')
    || m.includes('identity ambiguous')
}
