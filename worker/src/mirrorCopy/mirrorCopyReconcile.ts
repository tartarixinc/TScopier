/**
 * Pure helpers for the mirror-copy reconcile loop.
 *
 * Kept separate from the monitor so the ticket/comment/recovery rules can be unit
 * tested without a broker or database. The monitor wires these to I/O.
 */
import { extractClosedTradeFillsByTicket } from '../closedTradeFill'

/**
 * Deterministic broker comment for a copied position: `mc:<link8>:<ticket>`.
 * Used to recover an acknowledged order after a crash, so it must be stable and
 * short enough for the broker's comment limit (<= 31 chars, matching social copy).
 */
export function mirrorCopyComment(linkId: string, sourceTicket: string): string {
  return `mc:${linkId.slice(0, 8)}:${sourceTicket}`.slice(0, 31)
}

/** A mapping is still owned while it has not reached a terminal closed state. */
export function mappingIsOpen(state: string): boolean {
  return state !== 'closed'
}

/**
 * Whether closed history contains the given source position ticket.
 *
 * FxSocket history rows are deal-level: `ticket` is the closing deal and `position`
 * is the position id the engine tracks, and a partial close has a non-zero `order`.
 * `extractClosedTradeFillsByTicket` already resolves the position id and rejects
 * partial closes, so recovery reuses it rather than comparing the wrong field.
 *
 * An inconclusive result (false) must leave the copy open rather than silently drop
 * a possibly-live source ticket.
 */
export function historyContainsClosedPosition(
  rows: unknown[],
  positionTicket: string,
  provider: string | null | undefined,
): boolean {
  const wanted = Number(positionTicket)
  if (!Number.isFinite(wanted) || wanted <= 0) return false
  const name = String(provider ?? 'fxsocket').trim().toLowerCase() || 'fxsocket'
  try {
    return extractClosedTradeFillsByTicket(rows, 'trades', name).has(wanted)
  } catch {
    return false
  }
}
