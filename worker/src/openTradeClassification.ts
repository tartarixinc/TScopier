/**
 * Read-only classification of an open trade against broker state.
 *
 * Used by the stuck-trade diagnostic to answer, for each open row, one of:
 *   live      — a live position matches (ticket / explicit identity / attributes)
 *   ambiguous — multiple live positions match the stored trade (heuristic identity)
 *   closed    — no live match, but the ticket/comment appears in closed history
 *   missing   — no live match and no closed-history match
 *   unknown   — the broker read was not authoritative (unhealthy/incomplete)
 *
 * Pure: no I/O, no DB writes. Never mutates anything.
 */
import { resolveCanonicalOpenPosition, type LiveTradeIdentity } from './livePositionIdentity'

export type ClassifyTradeRow = LiveTradeIdentity & {
  signal_id?: string | null
  broker_account_id?: string | null
}

export type OpenTradeClassification =
  | { id: string; status: 'live'; matchedBy: string; ticket: number; comment: string | null }
  | { id: string; status: 'ambiguous'; reason: string }
  | {
      id: string
      status: 'closed'
      storedTicket: number | null
      matchedBy: 'ticket' | 'comment'
      closePrice: number | null
      closeTime: string | null
      comment: string | null
    }
  | { id: string; status: 'missing'; storedTicket: number | null }
  | { id: string; status: 'unknown'; reason: string }

const TICKET_KEYS = [
  'ticket', 'Ticket', 'positionTicket', 'PositionTicket', 'positionId', 'PositionId',
  'orderTicket', 'OrderTicket', 'order', 'Order', 'orderId', 'OrderId',
  'deal', 'Deal', 'dealId', 'DealId', 'dealTicket', 'DealTicket',
] as const

function ticketNumbers(row: Record<string, unknown>): number[] {
  const out: number[] = []
  for (const key of TICKET_KEYS) {
    const value = row[key]
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n) && n > 0) out.push(n)
  }
  return out
}

function commentOf(row: Record<string, unknown>): string | null {
  for (const key of ['comment', 'Comment', 'orderComment', 'OrderComment']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function closePriceOf(row: Record<string, unknown>): number | null {
  for (const key of ['closePrice', 'ClosePrice', 'price', 'Price', 'close_price']) {
    const n = Number(row[key])
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function closeTimeOf(row: Record<string, unknown>): string | null {
  for (const key of ['closeTime', 'CloseTime', 'time', 'Time', 'close_time', 'timestamp']) {
    const value = row[key]
    if (value == null) continue
    if (typeof value === 'string' && value.trim()) return value.trim()
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) {
      // MTAPI times are often unix seconds; keep raw and also ISO for readability.
      const ms = n < 1e12 ? n * 1000 : n
      return new Date(ms).toISOString()
    }
  }
  return null
}

/** Comment prefixes a stored trade could have been opened with (with and without channel slug). */
function expectedCommentFragments(trade: ClassifyTradeRow): string[] {
  const signalId = String(trade.signal_id ?? '').trim()
  if (!signalId) return []
  const id8 = signalId.slice(0, 8).toLowerCase()
  // The channel slug varies, so match on the trailing signal prefix only.
  return [id8]
}

function commentMatchesSignalPrefix(comment: string, fragments: string[]): boolean {
  const lower = comment.toLowerCase()
  return fragments.some(f => f.length === 8 && lower.includes(f))
}

export type ClosedHistoryMatch = {
  matchedBy: 'ticket' | 'comment'
  closePrice: number | null
  closeTime: string | null
  comment: string | null
}

/**
 * Positive proof that a trade is closed: its ticket or signal comment appears
 * in the broker's closed/order history. Used to corroborate a ghost close — an
 * empty live snapshot alone is not proof a position is gone.
 */
export function matchClosedHistory(
  trade: ClassifyTradeRow,
  closedOrders: unknown[],
): ClosedHistoryMatch | null {
  const storedRaw = Number(trade.metaapi_order_id)
  const storedTicket = Number.isFinite(storedRaw) && storedRaw > 0 ? storedRaw : null
  const fragments = expectedCommentFragments(trade)
  for (const raw of closedOrders) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const row = raw as Record<string, unknown>
    const tickets = ticketNumbers(row)
    const comment = commentOf(row)
    const matchedByTicket = storedTicket != null && tickets.includes(storedTicket)
    const matchedByComment = comment != null && commentMatchesSignalPrefix(comment, fragments)
    if (matchedByTicket || matchedByComment) {
      return {
        matchedBy: matchedByTicket ? 'ticket' : 'comment',
        closePrice: closePriceOf(row),
        closeTime: closeTimeOf(row),
        comment,
      }
    }
  }
  return null
}

export function classifyOpenTrade(args: {
  trade: ClassifyTradeRow
  openedOrders: unknown[]
  closedOrders: unknown[]
  /** True only when the session answered a health probe and the snapshot is authoritative. */
  openedHealthy: boolean
}): OpenTradeClassification {
  const { trade } = args
  const storedRaw = Number(trade.metaapi_order_id)
  const storedTicket = Number.isFinite(storedRaw) && storedRaw > 0 ? storedRaw : null

  if (!args.openedHealthy) {
    return { id: trade.id, status: 'unknown', reason: 'broker read not authoritative (session/incomplete)' }
  }

  const live = resolveCanonicalOpenPosition({ trade, openedOrders: args.openedOrders })
  if (live.status === 'resolved') {
    const row = live.row as Record<string, unknown>
    return {
      id: trade.id,
      status: 'live',
      matchedBy: live.matchedBy,
      ticket: live.ticket,
      comment: commentOf(row),
    }
  }
  if (live.status === 'ambiguous') {
    return { id: trade.id, status: 'ambiguous', reason: live.reason }
  }

  // Not live. Look for it in closed/order history by ticket, then by signal comment.
  const match = matchClosedHistory(trade, args.closedOrders)
  if (match) {
    return { id: trade.id, status: 'closed', storedTicket, ...match }
  }

  return { id: trade.id, status: 'missing', storedTicket }
}
