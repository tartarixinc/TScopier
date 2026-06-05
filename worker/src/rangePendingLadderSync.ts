/**
 * Keep range ladder state consistent on basket SL/TP refresh — update pending rungs
 * and only insert steps not yet fired. Prevents duplicate market fires when
 * parameter signals re-plan the full 4+6 layout.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  applyChannelParamsToVirtualLeg,
  type ChannelActiveTradeParams,
} from './channelActiveTradeParams'
import type { VirtualPendingLeg } from './manualPlanner'
import type { ManualTpLot } from './manualPlanning/types'

export const TERMINAL_RANGE_LEG_STATUSES = ['fired', 'expired', 'cancelled', 'failed'] as const

export type RangeLegRow = {
  id: string
  step_idx: number
  status: string
  stoploss: number | null
  takeprofit: number | null
  cwe_close_price?: number | null
}

export type RangeLadderScope = {
  signalId: string
  brokerAccountId: string
  symbol: string
}

async function hasRangePendingTpTouchLock(
  supabase: SupabaseClient,
  scope: RangeLadderScope,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('range_pending_tp_locks')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .eq('symbol', scope.symbol)
  if (error) {
    console.warn(
      `[rangePendingLadderSync] tp-lock lookup failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${error.message}`,
    )
    return false
  }
  return (count ?? 0) > 0
}

export async function loadRangeLegRows(
  supabase: SupabaseClient,
  scope: RangeLadderScope,
): Promise<RangeLegRow[]> {
  const { data, error } = await supabase
    .from('range_pending_legs')
    .select('id,step_idx,status,stoploss,takeprofit,cwe_close_price')
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .eq('symbol', scope.symbol)
    .limit(500)
  if (error) {
    console.warn(
      `[rangePendingLadderSync] load failed signal=${scope.signalId}: ${error.message}`,
    )
    return []
  }
  return (data ?? []) as RangeLegRow[]
}

export function consumedStepIndices(rows: RangeLegRow[]): Set<number> {
  const out = new Set<number>()
  for (const r of rows) {
    if (TERMINAL_RANGE_LEG_STATUSES.includes(r.status as typeof TERMINAL_RANGE_LEG_STATUSES[number])) {
      out.add(r.step_idx)
    }
  }
  return out
}

export function maxConsumedStepIndex(consumed: Set<number>): number {
  let max = 0
  for (const s of consumed) {
    if (s > max) max = s
  }
  return max
}

/**
 * On basket SL/TP refresh: patch SL/TP on active pendings; insert only rungs that
 * have not fired and respect total leg budget (immediates + range layering).
 */
export async function syncRangePendingLadderOnBasketRefresh(args: {
  supabase: SupabaseClient
  scope: RangeLadderScope
  virtualPendings: VirtualPendingLeg[]
  openTradeCount: number
  plannedImmediateLegs: number
  plannedRangeLegs: number
  channelParams?: ChannelActiveTradeParams | null
  tpLots?: ManualTpLot[] | null
  buildInsertRow: (leg: VirtualPendingLeg) => Record<string, unknown> | null
  persistRows: (rows: Record<string, unknown>[], context: string) => Promise<{ ok: boolean }>
  context: string
  layerTillClose?: boolean
}): Promise<{ updated: number; inserted: number; skippedConsumed: number; skippedCap: number }> {
  const {
    supabase,
    scope,
    virtualPendings,
    openTradeCount,
    plannedImmediateLegs,
    plannedRangeLegs,
    channelParams,
    tpLots,
    buildInsertRow,
    persistRows,
    context,
    layerTillClose = false,
  } = args

  const stats = { updated: 0, inserted: 0, skippedConsumed: 0, skippedCap: 0 }
  if (!virtualPendings.length) return stats

  const existing = await loadRangeLegRows(supabase, scope)
  const consumed = consumedStepIndices(existing)
  const maxConsumed = maxConsumedStepIndex(consumed)

  const rangeFilledEstimate = Math.max(0, openTradeCount - Math.max(0, plannedImmediateLegs))
  const minInsertStep = Math.max(maxConsumed, rangeFilledEstimate) + 1

  const planByStep = new Map<number, VirtualPendingLeg>()
  for (const v of virtualPendings) {
    planByStep.set(v.stepIdx, v)
  }

  const activeRows = existing.filter(r => r.status === 'pending' || r.status === 'claimed')
  const maxTotalLegs = Math.max(0, plannedImmediateLegs + plannedRangeLegs)
  const activePendingCount = activeRows.length

  for (const row of activeRows) {
    const planLeg = planByStep.get(row.step_idx)
    if (!planLeg) continue
    const legIndex = Math.max(0, row.step_idx - 1)
    const stops = applyChannelParamsToVirtualLeg(
      {
        stoploss: planLeg.stoploss,
        takeprofit: planLeg.cweClosePrice != null ? null : planLeg.takeprofit,
      },
      channelParams ?? null,
      { rangeLegIndex: legIndex, rangeLegCount: plannedRangeLegs, tpLots },
    )
    const patch: Record<string, unknown> = {
      stoploss: stops.stoploss,
      takeprofit: planLeg.cweClosePrice != null ? null : stops.takeprofit,
      cwe_close_price: planLeg.cweClosePrice ?? null,
    }
    const { error } = await supabase
      .from('range_pending_legs')
      .update(patch)
      .eq('id', row.id)
      .in('status', ['pending', 'claimed'])
    if (!error) stats.updated += 1
  }

  if (!layerTillClose && await hasRangePendingTpTouchLock(supabase, scope)) {
    // Layering frozen (TP touch or partial close with layer-till-close off).
    stats.skippedCap += virtualPendings.length
    return stats
  }

  const insertRows: Record<string, unknown>[] = []
  for (const v of virtualPendings) {
    if (consumed.has(v.stepIdx)) {
      stats.skippedConsumed += 1
      continue
    }
    if (v.stepIdx < minInsertStep) {
      stats.skippedConsumed += 1
      continue
    }
    if (activeRows.some(r => r.step_idx === v.stepIdx)) continue

    const projectedTotal = openTradeCount + activePendingCount + insertRows.length
    if (maxTotalLegs > 0 && projectedTotal >= maxTotalLegs) {
      stats.skippedCap += 1
      continue
    }

    const legIndex = Math.max(0, v.stepIdx - 1)
    const stops = applyChannelParamsToVirtualLeg(
      { stoploss: v.stoploss, takeprofit: v.takeprofit },
      channelParams ?? null,
      { rangeLegIndex: legIndex, rangeLegCount: plannedRangeLegs, tpLots },
    )
    const legForRow: VirtualPendingLeg = {
      ...v,
      stoploss: stops.stoploss ?? v.stoploss,
      takeprofit: stops.takeprofit ?? v.takeprofit,
    }
    const row = buildInsertRow(legForRow)
    if (row) insertRows.push(row)
  }

  if (insertRows.length > 0) {
    const persist = await persistRows(insertRows, context)
    if (persist.ok) stats.inserted = insertRows.length
  }

  return stats
}

/** Mark leg fired (retain row for ladder history). */
export async function markRangeLegFired(
  supabase: SupabaseClient,
  legId: string,
  ticket: number | string | null,
): Promise<void> {
  const { error } = await supabase
    .from('range_pending_legs')
    .update({
      status: 'fired',
      fired_at: new Date().toISOString(),
      ticket: ticket != null ? String(ticket) : null,
      claimed_at: null,
      claimed_by: null,
    })
    .eq('id', legId)
  if (error) {
    throw new Error(`markRangeLegFired failed leg=${legId}: ${error.message}`)
  }
}

/** Mark expired TTL legs (retain row). */
export async function markRangeLegsExpired(
  supabase: SupabaseClient,
  legIds: string[],
): Promise<void> {
  if (!legIds.length) return
  await supabase
    .from('range_pending_legs')
    .update({
      status: 'expired',
      error_message: 'pending_expiry',
    })
    .in('id', legIds)
    .eq('status', 'pending')
}
