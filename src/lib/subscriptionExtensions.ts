/**
 * Admin-granted access extensions (rows of the subscription_extensions table).
 *
 * A grant keeps a user's access alive after the trial or paid period ends.
 * Every access check treats "a live grant" as a third way to be active,
 * alongside an active subscription and an unexpired trial.
 */

export interface SubscriptionExtensionGrant {
  days: number
  granted_at: string
}

/** End of one grant in epoch milliseconds, or null when the row is unusable. */
export function grantEndMs(grant: SubscriptionExtensionGrant): number | null {
  const days = Number(grant.days)
  const start = Date.parse(grant.granted_at)
  if (!Number.isFinite(days) || days <= 0 || Number.isNaN(start)) return null
  return start + days * 86_400_000
}

/** Latest end across all grants, or null when none are usable. */
export function latestExtensionEndMs(
  grants: SubscriptionExtensionGrant[] | null | undefined,
): number | null {
  let latest: number | null = null
  for (const grant of grants ?? []) {
    const end = grantEndMs(grant)
    if (end != null && (latest == null || end > latest)) latest = end
  }
  return latest
}

/** True while a grant window is still open. */
export function isExtensionActive(endMs: number | null | undefined, now = Date.now()): boolean {
  return endMs != null && endMs > now
}
