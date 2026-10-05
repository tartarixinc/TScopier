/**
 * Reconcile DB `trades.status = 'open'` against live broker positions.
 * Closes rows whose ticket no longer appears in /OpenedOrders (TP/SL/manual close).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { closeStaleOpenTrades } from './basketSlTpReconcile'
import { persistCanonicalPositionTicket, resolveCanonicalOpenPosition } from './livePositionIdentity'
import { matchClosedHistory } from './openTradeClassification'
import { captureBusinessIssue } from './observability/businessEvents'
import { purgeRangePendingLegsForBaskets, type BasketScope } from './rangePendingLegDelete'

/** How far back to look for a close record when corroborating a ghost close. */
const HISTORY_DAYS = Math.max(1, Number(process.env.OPEN_TRADE_RECONCILE_HISTORY_DAYS ?? 30))

/**
 * Corroborate a ghost close with a positive close record. Default on; set
 * `OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY=false` to restore the old
 * absence-only behaviour (not recommended — it can mass-close on a false-empty
 * snapshot from a live session).
 */
function requireClosedHistory(): boolean {
  return process.env.OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY !== 'false'
}

function mtDate(d: Date): string {
  return d.toISOString().slice(0, 19)
}

async function loadClosedHistory(api: FxsocketBrokerClient, accountId: string): Promise<unknown[]> {
  try {
    const to = mtDate(new Date())
    const from = mtDate(new Date(Date.now() - HISTORY_DAYS * 86_400_000))
    return (await api.orderHistory(accountId, from, to)) ?? []
  } catch (err) {
    console.warn(
      `[openTradeReconcile] closed-history load failed account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }
}

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
      const ghostTrades = openTrades.filter(trade => {
        const ticket = Number(trade.metaapi_order_id)
        return Number.isFinite(ticket) && ticket > 0
      })
      if (!ghostTrades.length) return 0

      // An empty-but-successful snapshot is not proof a position is gone: a live
      // session can answer empty for the wrong account / a transient bridge
      // fault, and closing on that would strand a real, unmanaged position.
      // Require a positive close record (ticket or signal comment in history)
      // before closing; anything unconfirmed is deferred to review.
      let closableIds: string[]
      let unconfirmed: OpenTradeReconcileRow[]
      if (requireClosedHistory()) {
        const closedOrders = await loadClosedHistory(api, metaapiAccountId)
        const closable: string[] = []
        unconfirmed = []
        for (const trade of ghostTrades) {
          if (matchClosedHistory(trade, closedOrders)) closable.push(trade.id)
          else unconfirmed.push(trade)
        }
        closableIds = closable
      } else {
        closableIds = ghostTrades.map(trade => trade.id)
        unconfirmed = []
      }

      let closed = 0
      if (closableIds.length) {
        closed = await closeStaleOpenTrades(supabase, closableIds)
        if (closed > 0) {
          const scopes = basketScopesForGhosts(openTrades, closableIds)
          if (scopes.length) {
            await purgeRangePendingLegsForBaskets(supabase, scopes, 'basket_flat_reconcile')
          }
          console.warn(
            `[openTradeReconcile] session healthy with no open positions — closed ${closed} stale row(s)`
            + ` confirmed in history account=${metaapiAccountId}`,
          )
        }
      }

      if (unconfirmed.length) {
        console.warn(
          `[openTradeReconcile] empty OpenedOrders but ${unconfirmed.length} trade(s) not confirmed in`
          + ` history account=${metaapiAccountId} — deferring (needs review)`,
        )
        captureBusinessIssue({
          category: 'reconciliation',
          event: 'reconciliation_needs_review',
          severity: 'warning',
          reasonCode: 'GHOST_UNCONFIRMED_BY_HISTORY',
          message: 'Flat account snapshot not corroborated by closed history',
          userImpact: 'manual_review_required',
          fingerprint: ['reconciliation_needs_review', 'open_trade_reconcile', 'GHOST_UNCONFIRMED_BY_HISTORY'],
          context: {
            broker_account_id: metaapiAccountId,
            stage: 'open_trade_reconcile',
            operation: 'open_trade_reconcile',
            extra: {
              unconfirmed_trades: unconfirmed.length,
              trade_ids: unconfirmed.slice(0, 10).map(t => t.id),
            },
          },
        })
      }
      return closed
    }
    console.warn(
      `[openTradeReconcile] empty OpenedOrders with ${openTrades.length} tracked open trade(s)`
      + ` account=${metaapiAccountId} — deferring ghost close (suspected disconnect)`,
    )
    return 0
  }

  // The reason is the whole point: 'stored ticket maps to multiple live
  // positions' and 'attributes match multiple live positions' have different
  // fixes, and neither was visible in the log before. Signal-derived symbol
  // text is stripped to a log-safe shape so a crafted symbol cannot forge a
  // line.
  const logAmbiguous = (trade: OpenTradeReconcileRow, reason: string, pass: string): void => {
    console.warn(
      `[openTradeReconcile] identity ambiguous trade=${trade.id}`
      + ` ticket=${trade.metaapi_order_id ?? 'none'}`
      + ` symbol=${String(trade.symbol ?? 'unknown').replace(/[^\w./-]/g, '_')}`
      + ` reason="${reason}" pass=${pass} — deferring close`,
    )
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
      logAmbiguous(trade, resolution.reason, 'first')
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
    if (resolution.status === 'ambiguous') {
      // Previously dropped on the floor here: only 'missing' was collected, so
      // a trade that turned ambiguous on the second pass was deferred with no
      // log line at all.
      logAmbiguous(trade, resolution.reason, 'second')
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
