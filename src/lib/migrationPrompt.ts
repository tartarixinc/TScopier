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
  // A paused account is not copying anything: even a failed attempt on it must
  // not trap the customer in a dialog they cannot close.
  if (active.is_active === false) return true
  return !needingReconnect.some(broker => broker.id === active.id)
}

/**
 * Where a reconnect failure has to be shown.
 *
 * The page registers its own handler (a toast or a banner), but the automatic
 * prompt sits on top of that page and cannot be dismissed — so a message sent
 * only to the page is hidden behind the dialog and the customer sees nothing
 * happen at all. The dialog always gets the message; the page too, for
 * when the prompt is closed and the banner is readable.
 */
export function routeReconnectError(
  message: string,
  targets: {
    dialog: (message: string) => void
    page?: ((message: string) => void) | null
  },
): void {
  targets.dialog(message)
  targets.page?.(message)
}

/**
 * The reconnect dialog's four faces:
 * - `details` — stage 1: account details and the Reconnect button;
 * - `password` — stage 2: the password form;
 * - `connecting` — sign-in accepted, waiting on the broker bridge;
 * - `success` — the account reconnected, confirmed before the dialog moves on.
 */
export type ReconnectDialogStage = 'details' | 'password' | 'connecting' | 'success'

/**
 * Which account the dialog is about and which stage it shows.
 *
 * Precedence, highest first:
 * 1. an open password prompt — the customer is typing, nothing outranks it;
 * 2. a success to confirm — shown before the dialog advances or closes;
 * 3. an attempt still waiting on the bridge — the dialog stays on that
 *    account instead of jumping ahead to the next one;
 * 4. a failed attempt's account — anchored even when its row is mid-connect
 *    (`pending`) and therefore no longer on the needs-reconnect list, so the
 *    error is never shown behind a dialog that just closed;
 * 5. the automatic prompt for the next account that needs reconnecting.
 */
export function resolveReconnectDialog<T extends { id: string }>(args: {
  passwordPrompt: T | null
  success: T | null
  inflight: T | null
  errorAnchor: T | null
  migrationPrompt: T | null
}): { active: T | null; stage: ReconnectDialogStage } {
  if (args.passwordPrompt) return { active: args.passwordPrompt, stage: 'password' }
  if (args.success) return { active: args.success, stage: 'success' }
  if (args.inflight) return { active: args.inflight, stage: 'connecting' }
  if (args.errorAnchor) return { active: args.errorAnchor, stage: 'details' }
  return { active: args.migrationPrompt, stage: 'details' }
}
