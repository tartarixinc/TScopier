/**
 * Mirror-copy policy for the broker account execution mode.
 *
 * On a hedging account each symbol may hold independent buy and sell positions, so a
 * copied position stands alone. On a netting account a second order on the same symbol
 * merges into the existing position, so naive open/close would be wrong. Mirror copy
 * therefore runs only on accounts whose stored mode is confirmed hedging.
 *
 * Detection lives in the neutral copyShared/brokerAccountMode helper (shared with the
 * session manager); only the mirror-specific policy is here.
 */
export { accountModeFromSummary, type BrokerAccountMode } from '../copyShared/brokerAccountMode'

/** Whether mirror copy may run against an account with this stored mode. */
export function mirrorCopyAccountModeSupported(mode: string | null | undefined): boolean {
  return String(mode ?? '').trim().toLowerCase() === 'hedging'
}
