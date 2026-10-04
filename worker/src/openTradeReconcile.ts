/**
 * Reconcile DB `trades.status = 'open'` against live broker positions.
 * Closes rows whose ticket no longer appears in /OpenedOrders (TP/SL/manual close).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { closeStaleOpenTrades } from './basketSlTpReconcile'
import { persistCanonicalPositionTicket, resolveCanonicalOpenPosition } from './livePositionIdentity'
import { purgeRangePendingLegsForBaskets, type BasketScope } from './rangePendingLegDelete'

export type OpenTradeReconcileRow = {
  id: string
  signal_id?: string | null
  broker_account_id: string | null
  metaapi_order_id: string | null
  symbol?: string | null
  direction?: string | null
  lot_size?: number | null
  entry_price?: number | null
}

/** A session probe may only authorise a close when it resolves. */
async function sessionIsHealthy(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe()
    return true
  } catch {
    return false
  }
}

/** Open DB legs whose ticket is valid but absent from the broker snapshot. */
export function findGhostOpenTradeIds(
  openTrades: OpenTradeReconcileRow[],
  brokerTickets: Set<number>,
): string[] {
  const ghostIds: string[] = []
  for (const trade of openTrades) {
    const ticket = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue
    if (!brokerTickets.has(ticket)) ghostIds.push(trade.id)
  }
  return ghostIds
}

function basketScopesForGhosts(openTrades: OpenTradeReconcileRow[], ghostIds: string[]): BasketScope[] {
  const ghostSet = new Set(ghostIds)
  const scopes = new Map<string, BasketScope>()
  for (const trade of openTrades) {
    if (!ghostSet.has(trade.id)) continue
    const signalId = trade.signal_id
    const brokerAccountId = trade.broker_account_id
    if (!signalId || !brokerAccountId) continue
    scopes.set(`${signalId}|${brokerAccountId}`, { signalId, brokerAccountId })
  }
  return [...scopes.values()]
}

export async function reconcileOpenTradesForBroker(
  supabase: SupabaseClient,
  api: FxsocketBrokerClient,
  metaapiAccountId: string,
  openTrades: OpenTradeReconcileRow[],
  probeHealthy?: () => Promise<unknown>,
): Promise<number> {
  if (!openTrades.length) return 0
  const firstSnapshot = await api.openedOrders(metaapiAccountId)
  // SAFETY: an empty (but successful) OpenedOrders snapshot usually means the
  // broker session is disconnected — never mass-mark every open row closed.
  // A genuinely flat account answers empty too, so the session itself is
  // asked: only a healthy session may authorise closing the last rows.
  // Without that check the final trade on an account could never be
  // reconciled, because closing it is exactly what makes the account empty
  // (2026-10-04: trade 400406267 sat open in the database while closed at the
  // broker, and Manage Signals showed its signal open forever).
  if (!Array.isArray(firstSnapshot) || firstSnapshot.length === 0) {
    if (probeHealthy && await sessionIsHealthy(probeHealthy)) {
      const emptyAgain = await api.openedOrders(metaapiAccountId)
      if (Array.isArray(emptyAgain) && emptyAgain.length > 0) return 0
      const ghostIds = openTrades
        .filter(trade => {
          const ticket = Number(trade.metaapi_order_id)
          return Number.isFinite(ticket) && ticket > 0
        })
        .map(trade => trade.id)
      if (!ghostIds.length) return 0
      const closed = await closeStaleOpenTrades(supabase, ghostIds)
      if (closed > 0) {
        const scopes = basketScopesForGhosts(openTrades, ghostIds)
        if (scopes.length) {
          await purgeRangePendingLegsForBaskets(supabase, scopes, 'basket_flat_reconcile')
        }
        console.warn(
          `[openTradeReconcile] session healthy with no open positions — closed ${closed} stale row(s)`
          + ` account=${metaapiAccountId}`,
        )
      }
      return closed
    }
    console.warn(
      `[openTradeReconcile] empty OpenedOrders with ${openTrades.length} tracked open trade(s)`
      + ` account=${metaapiAccountId} — deferring ghost close (suspected disconnect)`,
    )
    return 0
  }

  const absentOnce: OpenTradeReconcileRow[] = []
  for (const trade of openTrades) {
    const resolution = resolveCanonicalOpenPosition({ trade, openedOrders: firstSnapshot })
    if (resolution.status === 'resolved') {
      if (resolution.replacement) {
        const persisted = await persistCanonicalPositionTicket(supabase, trade, resolution)
        if (!persisted) {
          console.warn(`[openTradeReconcile] replacement ticket CAS lost trade=${trade.id}; deferring`)
        }
      }
      continue
    }
    if (resolution.status === 'ambiguous') {
      console.warn(`[openTradeReconcile] identity ambiguous trade=${trade.id}; deferring close`)
      continue
    }
    absentOnce.push(trade)
  }
  if (!absentOnce.length) return 0

  // One non-empty snapshot is not sufficient evidence of closure. Require the
  // same trade to be absent from a second complete snapshot before changing DB state.
  const secondSnapshot = await api.openedOrders(metaapiAccountId)
  if (!Array.isArray(secondSnapshot) || secondSnapshot.length === 0) {
    console.warn(
      `[openTradeReconcile] second OpenedOrders snapshot empty/incomplete account=${metaapiAccountId}; deferring close`,
    )
    return 0
  }

  const ghostIds: string[] = []
  for (const trade of absentOnce) {
    const resolution = resolveCanonicalOpenPosition({ trade, openedOrders: secondSnapshot })
    if (resolution.status === 'resolved') {
      if (resolution.replacement) {
        const persisted = await persistCanonicalPositionTicket(supabase, trade, resolution)
        if (!persisted) {
          console.warn(`[openTradeReconcile] replacement ticket CAS lost trade=${trade.id}; deferring`)
        }
      }
      continue
    }
    if (resolution.status === 'missing') ghostIds.push(trade.id)
  }
  if (!ghostIds.length) return 0
  const closed = await closeStaleOpenTrades(supabase, ghostIds)
  if (closed > 0) {
    const scopes = basketScopesForGhosts(openTrades, ghostIds)
    if (scopes.length) {
      await purgeRangePendingLegsForBaskets(supabase, scopes, 'basket_flat_reconcile')
    }
  }
  return closed
}
