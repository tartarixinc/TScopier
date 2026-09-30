import type { BrokerAccount } from '../types/database'

/**
 * The case the migration prompt exists for: an account moved to MTAPI that has
 * never connected through it, so it cannot copy anything yet. Anything else —
 * an ordinary FxSocket session expiry, or an MTAPI session that dropped later —
 * keeps the existing session-expiry wording.
 */
export function isMigrationSwitchCase(broker: BrokerAccount | null | undefined): boolean {
  return broker?.provider === 'mtapi' && (broker.mtapi_status ?? null) == null
}

/**
 * Which account the automatic prompt is about, or null when it should not show.
 *
 * - paused accounts are skipped: copying is off, so there is nothing to keep
 *   running and interrupting the whole app for them would be wrong;
 * - accounts whose reconnect is already in flight are skipped, so the dialog
 *   never drops back to stage 1 while an attempt is running;
 * - otherwise the first account that still needs reconnecting wins, which is
 *   what makes the prompt advance to the next account after a success.
 */
export function pickPromptBroker(
  needingReconnect: readonly BrokerAccount[],
  reconnectingIds: ReadonlySet<string>,
): BrokerAccount | null {
  return needingReconnect.find(
    broker => broker.is_active !== false && !reconnectingIds.has(broker.id),
  ) ?? null
}

/**
 * Whether the dialog showing `active` may be closed.
 *
 * It may not: an account that still needs reconnecting must stay prompted until
 * it is resolved. It may when the customer opened the dialog themselves — an
 * ordinary session-expiry reconnect that is not on the needs-reconnect list.
 */
export function isPromptDismissible(
  needingReconnect: readonly BrokerAccount[],
  active: BrokerAccount | null | undefined,
): boolean {
  if (!active) return false
  return !needingReconnect.some(broker => broker.id === active.id)
}
