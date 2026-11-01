/**
 * Pure helpers for the mirror-copy reconcile loop.
 *
 * Kept separate from the monitor so the ticket/comment/recovery rules can be unit
 * tested without a broker or database. The monitor wires these to I/O.
 */
import { extractClosedTradeFillsByTicket, mtCloseRowRejection } from '../closedTradeFill'
import { resolveMtTicket } from '../mtTradeFields'

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
 * Two shapes have to be understood, in this order:
 *
 * 1. **Position-level rows** — the row's own `ticket` is the position id and it
 *    passes the structural close gates (`mtCloseRowRejection`: a close time, a
 *    positive size, a symbol, no cancelled/pending state). These rows prove the
 *    position is closed on their own, even when they carry **no price and no
 *    profit**: a cTrader closing deal and a position this worker watched
 *    disappear from a crypto book both look exactly like that. Closedness never
 *    needed a value — the value gates exist so a fill is only *written*, not so
 *    a close is only *believed*.
 * 2. **Deal-level rows** (FxSocket) — `ticket` is the closing deal, not the
 *    position, so they are resolved through
 *    `extractClosedTradeFillsByTicket`, which reads the position id out of the
 *    closing deal and rejects partial closes (`order !== 0`). Rows that pass
 *    that gate also supply their fill, which is why path 1 never pre-empts it
 *    with a weaker test: an FxSocket row has no close time, so it always falls
 *    through to here.
 *
 * An inconclusive result (false) must leave the copy open rather than silently
 * drop a possibly-live source ticket.
 */
export function historyContainsClosedPosition(
  rows: unknown[],
  positionTicket: string,
  provider: string | null | undefined,
): boolean {
  const wanted = Number(positionTicket)
  if (!Number.isFinite(wanted) || wanted <= 0) return false
  const name = String(provider ?? 'fxsocket').trim().toLowerCase() || 'fxsocket'
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const raw = row as Record<string, unknown>
    if (resolveMtTicket(raw, 'trades') !== wanted) continue
    if (mtCloseRowRejection(raw, 'trades') != null) continue
    return true
  }
  try {
    return extractClosedTradeFillsByTicket(rows, 'trades', name).has(wanted)
  } catch {
    return false
  }
}
