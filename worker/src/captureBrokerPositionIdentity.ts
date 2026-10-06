import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCanonicalOpenPosition, type LiveTradeIdentity } from './livePositionIdentity'

/**
 * Record the broker's position identity for a freshly filled trade.
 *
 * On MT5 the ticket returned by an order send and the ticket that identifies
 * the resulting live position are different numbers. This resolves the just
 * filled ticket against a broker read taken right after the fill and stores
 * the position number in `trades.broker_position_ticket`, which every later
 * position lookup prefers.
 *
 * A guessed value is never stored: only a certain resolution is written. When
 * the position is not yet visible, or the read is ambiguous, the column stays
 * null and readers fall back to `metaapi_order_id`.
 */
export async function captureBrokerPositionIdentity(args: {
  supabase: SupabaseClient
  tradeRowId: string
  trade: LiveTradeIdentity
  openedOrders: unknown[] | null
}): Promise<number | null> {
  if (!Array.isArray(args.openedOrders)) return null

  const resolution = resolveCanonicalOpenPosition({
    trade: args.trade,
    openedOrders: args.openedOrders,
  })
  if (resolution.status !== 'resolved') return null
  // Only a ticket-based match is certain. An attribute-only match (several or
  // even one candidate distinguished by symbol/side/lots/price) must never be
  // frozen into the row — that is exactly the guess the design review rejected.
  if (resolution.matchedBy === 'attributes') return null

  const positionTicket = resolution.ticket
  const { error } = await args.supabase
    .from('trades')
    .update({ broker_position_ticket: String(positionTicket) })
    .eq('id', args.tradeRowId)
    .is('broker_position_ticket', null)
  if (error) {
    console.warn(
      `[captureBrokerPositionIdentity] write failed trade=${args.tradeRowId}: ${error.message}`,
    )
    return null
  }
  return positionTicket
}
