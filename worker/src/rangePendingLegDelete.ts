/**
 * Delete active `range_pending_legs` when a signal basket is flat or layering
 * must stop (Layer-till-close OFF after a TP hit).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { clearTpTouchedLock } from './rangePendingFireGuard'
import { apiForFxsocketAccount, resolveDurableBrokerArtifacts } from './mtApiByAccount'
import { cancelBrokerRangeLegAtBroker, type RangeBrokerPendingRow } from './rangeBrokerPendingHelpers'
import { isPendingEntryRow, rawOrderTicket } from './signalEntryPendingHelpers'

export type BasketScope = {
  signalId: string
  brokerAccountId: string
}

export const ACTIVE_RANGE_PENDING_LEG_STATUSES = ['pending', 'claimed', 'broker_pending'] as const

function readComment(row: unknown): string {
  if (row == null || typeof row !== 'object') return ''
  const o = row as Record<string, unknown>
  const c = o.comment ?? o.Comment
  return typeof c === 'string' ? c : ''
}

export async function hasActiveRangePendingLegs(
  supabase: SupabaseClient,
  scope: BasketScope,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('range_pending_legs')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .in('status', [...ACTIVE_RANGE_PENDING_LEG_STATUSES])
  if (error) {
    console.warn(`[rangePendingLegDelete] active pending check failed signal=${scope.signalId}: ${error.message}`)
    return true
  }
  return (count ?? 0) > 0
}

async function hasClosedTradeHistory(
  supabase: SupabaseClient,
  scope: BasketScope,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('trades')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .eq('status', 'closed')
  if (error) {
    console.warn(`[rangePendingLegDelete] closed-history check failed signal=${scope.signalId}: ${error.message}`)
    return true
  }
  return (count ?? 0) > 0
}

/**
 * Cancel resting BuyLimit/SellLimit tickets for this basket, then remove DB rows.
 * Used when Layer-till-close is OFF and a TP is hit (or basket goes flat).
 */
async function cancelBrokerPendingLegsForScope(
  supabase: SupabaseClient,
  scope: BasketScope,
  reason: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('range_pending_legs')
    .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,ticket,comment,symbol')
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .eq('status', 'broker_pending')
  if (error || !data?.length) return 0

  const resolved = await resolveDurableBrokerArtifacts(
    supabase,
    data as RangeBrokerPendingRow[],
  )
  const platform = resolved.platformBySession
  let cancelled = 0
  const byAccount = new Map<string, RangeBrokerPendingRow[]>()
  for (const row of resolved.rows) {
    const list = byAccount.get(row.metaapi_account_id) ?? []
    list.push(row)
    byAccount.set(row.metaapi_account_id, list)
  }

  const signalNeedle = scope.signalId.slice(0, 8)

  for (const [uuid, rows] of byAccount) {
    const api = apiForFxsocketAccount(platform, uuid)
    if (!api) continue

    for (const row of rows) {
      const ok = await cancelBrokerRangeLegAtBroker(supabase, api, row, reason)
      if (ok) cancelled += 1
    }

    // Sweep leftover limit tickets whose comment still references this signal
    // (covers ticket mismatch / failed OrderClose leaving orphans on the chart).
    try {
      const opened = await api.openedOrders(uuid)
      const closedTickets = new Set<number>()
      for (const raw of opened) {
        if (!raw || typeof raw !== 'object') continue
        const o = raw as Record<string, unknown>
        if (!isPendingEntryRow(o)) continue
        const comment = readComment(raw)
        if (!comment.includes(signalNeedle) && !comment.includes(scope.signalId)) continue
        const ticket = rawOrderTicket(o)
        if (!(ticket > 0) || closedTickets.has(ticket)) continue
        try {
          await api.orderClose(uuid, { ticket })
          closedTickets.add(ticket)
          cancelled += 1
          console.log(
            `[rangePendingLegDelete] swept orphan limit ticket=${ticket}`
            + ` signal=${scope.signalId} reason=${reason}`,
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(
            `[rangePendingLegDelete] orphan limit OrderClose failed ticket=${ticket}`
            + ` signal=${scope.signalId}: ${msg}`,
          )
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[rangePendingLegDelete] OpenedOrders sweep failed signal=${scope.signalId}: ${msg}`,
      )
    }
  }
  return cancelled
}

/** Delete all active virtual / broker ladder rows for a basket (any symbol spelling). */
export async function deleteRangePendingLegsForBasket(
  supabase: SupabaseClient,
  scope: BasketScope,
  reason: string,
): Promise<number> {
  const brokerCancelled = await cancelBrokerPendingLegsForScope(supabase, scope, reason)

  const { data, error } = await supabase
    .from('range_pending_legs')
    .delete()
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .in('status', ['pending', 'claimed', 'broker_pending', 'cancelled'])
    .select('id')
  if (error) {
    // Fallback: still clear actives if cancelled-inclusive delete is rejected.
    const { data: activeOnly, error: activeErr } = await supabase
      .from('range_pending_legs')
      .delete()
      .eq('signal_id', scope.signalId)
      .eq('broker_account_id', scope.brokerAccountId)
      .in('status', ['pending', 'claimed', 'broker_pending'])
      .select('id')
    if (activeErr) {
      console.warn(
        `[rangePendingLegDelete] delete failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${activeErr.message}`,
      )
      return brokerCancelled
    }
    const n = (activeOnly ?? []).length
    if (n > 0 || brokerCancelled > 0) {
      console.log(
        `[rangePendingLegDelete] deleted ${n} range_pending_legs`
        + ` broker_cancelled=${brokerCancelled}`
        + ` signal=${scope.signalId} broker=${scope.brokerAccountId} reason=${reason}`,
      )
    }
    return Math.max(n, brokerCancelled)
  }
  const n = (data ?? []).length
  if (n > 0 || brokerCancelled > 0) {
    console.log(
      `[rangePendingLegDelete] deleted ${n} range_pending_legs`
      + ` broker_cancelled=${brokerCancelled}`
      + ` signal=${scope.signalId} broker=${scope.brokerAccountId} reason=${reason}`,
    )
  }
  return Math.max(n, brokerCancelled)
}

/** Delete active legs when no open/pending trades remain and no pending-only basket is still waiting. */
export async function purgeRangePendingLegsIfBasketFlat(
  supabase: SupabaseClient,
  scope: BasketScope,
  reason: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('trades')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .in('status', ['open', 'pending'])
  if (error) {
    console.warn(`[rangePendingLegDelete] flat-check failed signal=${scope.signalId}: ${error.message}`)
    return 0
  }
  if ((count ?? 0) > 0) return 0

  if (await hasActiveRangePendingLegs(supabase, scope)) {
    if (!await hasClosedTradeHistory(supabase, scope)) return 0
  }

  const deleted = await deleteRangePendingLegsForBasket(supabase, scope, reason)
  if (deleted > 0) {
    await clearTpTouchedLock(supabase, scope)
  }
  return deleted
}

export async function purgeRangePendingLegsForBaskets(
  supabase: SupabaseClient,
  scopes: Iterable<BasketScope>,
  reason: string,
): Promise<number> {
  const uniq = new Map<string, BasketScope>()
  for (const s of scopes) {
    uniq.set(`${s.signalId}|${s.brokerAccountId}`, s)
  }
  let total = 0
  for (const scope of uniq.values()) {
    total += await purgeRangePendingLegsIfBasketFlat(supabase, scope, reason)
  }
  return total
}
