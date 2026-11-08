/**
 * Cancel resting `trades`-pending orders — explicit LIMIT/STOP entries.
 *
 * An explicit "BUY LIMIT @ …" entry writes only the trade row: it never gets a
 * `signal_entry_pending_orders` record, so the sep-row cancel sweeps find
 * nothing for it (seen live 2026-11-07: reply-scoped `delete_pendings` returned
 * `delete_pendings_none` with four live resting orders, and channel close-all
 * cancelled none of them). The app's force-close path already handles these
 * rows; this helper gives the chat commands (delete_pendings, channel close)
 * the same capability.
 *
 * Safety, because a `trades` row can lag the broker by up to one drift tick
 * (~5 min) after a fill:
 *  - the ticket is verified against a fresh `openedOrders` snapshot first:
 *    a filled position is never sent to the cancel endpoint (on FXSocket
 *    `orderCancel` is literally `OrderClose`, so a blind cancel would close a
 *    live position under a cancel-only command);
 *  - a snapshot that cannot be fetched means nothing is cancelled this round
 *    (fail safe — the promote/TTL paths converge the rows later);
 *  - a ticket the broker no longer reports at all is left to the drift sweep
 *    rather than settled blindly (a replaced ticket must not be labelled
 *    cancelled while a position is still live);
 *  - the row is settled with a CAS on `status='pending'`, so a concurrent
 *    fill or promote is never clobbered, and only rows the database changed
 *    are counted.
 *
 * Providers without `openedOrders` keep the pre-verification behaviour
 * (cancel directly) — every real provider exposes the snapshot today.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { cancelPendingOrderAtBroker, type PendingCancelApi } from './pendingOrderCancel'
import { isPendingEntryRow, rawOrderTicket } from './signalEntryPendingHelpers'

export type TradesPendingCancelCounts = {
  /** Resting rows found for the given signals/brokers. */
  found: number
  /** Cancelled at the broker and settled to `cancelled` in the database. */
  cancelled: number
  /** Broker refused the cancel (or the ticket was invalid) — row left pending. */
  failed: number
  /** Ticket is now a live position — left for management/promote. */
  filled: number
  /** Ticket absent from the broker snapshot — left for the drift sweep. */
  absent: number
  /** No usable broker session for the row's account — row left pending. */
  unresolvable: number
  /** Snapshot could not be fetched — nothing was cancelled this round. */
  unverifiable: number
}

export type TradesPendingCancelArgs = {
  supabase: SupabaseClient
  /** Signals whose resting `trades`-pending orders may be cancelled. */
  signalIds: string[]
  /** Restrict to these broker accounts (every caller passes an explicit set). */
  brokerAccountIds: string[]
  /** Broker access for a `trades.broker_account_id`; null when unavailable. */
  resolve: (brokerAccountId: string) => { api: PendingCancelApi; sessionId: string } | null
  limit?: number
}

function emptyCounts(): TradesPendingCancelCounts {
  return {
    found: 0,
    cancelled: 0,
    failed: 0,
    filled: 0,
    absent: 0,
    unresolvable: 0,
    unverifiable: 0,
  }
}

async function settleCancelled(supabase: SupabaseClient, tradeId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('trades')
    .update({ status: 'cancelled', closed_at: new Date().toISOString() })
    .eq('id', tradeId)
    .eq('status', 'pending')
    .select('id')
  if (error) {
    console.warn(`[tradesPendingCancel] settle failed trade=${tradeId}: ${error.message}`)
    return false
  }
  return Boolean(data?.length)
}

export async function cancelTradesPendingOrders(
  args: TradesPendingCancelArgs,
): Promise<TradesPendingCancelCounts> {
  const counts = emptyCounts()
  const { supabase, signalIds, brokerAccountIds, resolve } = args
  if (!signalIds.length || !brokerAccountIds.length) return counts

  const { data: rows, error } = await supabase
    .from('trades')
    .select('id, broker_account_id, metaapi_order_id')
    .in('signal_id', signalIds)
    .in('broker_account_id', brokerAccountIds)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(args.limit ?? 200)
  if (error) {
    console.warn(`[tradesPendingCancel] lookup failed: ${error.message}`)
    return counts
  }
  const pending = (rows ?? []) as Array<{
    id: string
    broker_account_id: string
    metaapi_order_id: string | null
  }>
  counts.found = pending.length
  if (!pending.length) return counts

  const byBroker = new Map<string, typeof pending>()
  for (const row of pending) {
    const list = byBroker.get(row.broker_account_id) ?? []
    list.push(row)
    byBroker.set(row.broker_account_id, list)
  }

  for (const [brokerAccountId, list] of byBroker) {
    const target = resolve(brokerAccountId)
    if (!target) {
      counts.unresolvable += list.length
      continue
    }

    let snapshot: Map<number, Record<string, unknown>> | null = null
    if (typeof target.api.openedOrders === 'function') {
      try {
        const orders = await target.api.openedOrders(target.sessionId)
        snapshot = new Map<number, Record<string, unknown>>()
        for (const raw of orders ?? []) {
          if (!raw || typeof raw !== 'object') continue
          const order = raw as Record<string, unknown>
          const ticket = rawOrderTicket(order)
          if (ticket > 0) snapshot.set(ticket, order)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[tradesPendingCancel] snapshot failed broker=${brokerAccountId}: ${msg}`
          + ` — leaving ${list.length} row(s) for the promote/TTL paths`,
        )
        counts.unverifiable += list.length
        continue
      }
    }

    for (const row of list) {
      const ticket = Number(row.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) {
        counts.failed += 1
        console.warn(`[tradesPendingCancel] invalid ticket trade=${row.id} ticket=${row.metaapi_order_id}`)
        continue
      }

      if (snapshot) {
        const order = snapshot.get(ticket)
        if (!order) {
          counts.absent += 1
          continue
        }
        if (!isPendingEntryRow(order)) {
          // It filled: a cancel-only command must not touch a live position.
          counts.filled += 1
          continue
        }
      }

      try {
        await cancelPendingOrderAtBroker(target.api, target.sessionId, ticket)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[tradesPendingCancel] cancel failed trade=${row.id} ticket=${ticket}: ${msg}`,
        )
        counts.failed += 1
        continue
      }
      if (await settleCancelled(supabase, row.id)) counts.cancelled += 1
    }
  }
  return counts
}
