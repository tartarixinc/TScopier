import { readBrokerOrderStopLoss } from './signalEntryPendingHelpers'
import { resolveCanonicalOpenPosition, type LiveTradeIdentity } from './livePositionIdentity'

export type BrokerStopRead = {
  /** The position was found in the snapshot by a certain (ticket-based) identity. */
  found: boolean
  /** The stop the broker holds for it, or null when it holds none. */
  stoploss: number | null
}

export type BrokerStopConfirmation = BrokerStopRead & { confirmed: boolean }

const NOT_FOUND: BrokerStopRead = { found: false, stoploss: null }

/**
 * Read the stop the broker currently holds for a tracked trade from a
 * `/OpenedOrders` snapshot.
 *
 * The lookup reuses `resolveCanonicalOpenPosition`, so a position the broker
 * reports under a different identity (MT5 order ticket vs position ticket) is
 * found the same way an OrderModify targeted it. An attribute-only match is
 * NEVER accepted: when a basket holds many identical legs that is a guess, and a
 * guess must not be reported as certainty.
 */
export function readTradeBrokerStop(args: {
  openedOrders: unknown[] | null | undefined
  trade: LiveTradeIdentity
  /** Resolve against this canonical ticket instead of the row's stored identity. */
  ticketOverride?: number
}): BrokerStopRead {
  if (!Array.isArray(args.openedOrders)) return NOT_FOUND
  let trade = args.trade
  if (args.ticketOverride != null) {
    if (!Number.isFinite(args.ticketOverride) || args.ticketOverride <= 0) return NOT_FOUND
    trade = { ...args.trade, broker_position_ticket: String(args.ticketOverride) }
  }
  const resolution = resolveCanonicalOpenPosition({ trade, openedOrders: args.openedOrders })
  if (resolution.status !== 'resolved' || resolution.matchedBy === 'attributes') return NOT_FOUND
  return { found: true, stoploss: readBrokerOrderStopLoss(resolution.row) }
}

/**
 * Confirm from a fresh broker read that a stop move actually landed.
 *
 * The monitors used to record a new stop in `trades.sl` and stamp
 * `auto_be_applied_at` purely because `orderModify` returned without throwing.
 * That is not proof the broker took the stop: on 2026-10-16 two runner legs on
 * account 9e869a6f were logged "applied sl→…" and marked protected, yet both
 * showed S/L "-" on the broker for the whole life of the trade — and because
 * they left the auto-BE work set, nothing ever repaired them.
 */
export function confirmBrokerStopApplied(args: {
  openedOrders: unknown[] | null | undefined
  trade: LiveTradeIdentity
  /** The canonical ticket the modify was issued against. */
  ticket: number
  expectedSl: number
  isBuy: boolean
  /** Absolute price tolerance (typically half the symbol point). */
  tolerance?: number
}): BrokerStopConfirmation {
  const read = readTradeBrokerStop({
    openedOrders: args.openedOrders,
    trade: args.trade,
    ticketOverride: args.ticket,
  })
  if (!read.found || read.stoploss == null) {
    return { confirmed: false, found: read.found, stoploss: read.stoploss }
  }
  const tolerance = args.tolerance != null && Number.isFinite(args.tolerance)
    ? Math.abs(args.tolerance)
    : 1e-8
  // "At least as protective as requested": a stop the broker placed further in
  // our favour (e.g. a trailing stop) is still protection, so it must not be
  // reported as a failure — that would wedge an already-safe leg into a retry
  // loop. A stop left looser than requested, or absent, is not confirmation.
  const confirmed = args.isBuy
    ? read.stoploss >= args.expectedSl - tolerance
    : read.stoploss <= args.expectedSl + tolerance
  return { confirmed, found: true, stoploss: read.stoploss }
}
