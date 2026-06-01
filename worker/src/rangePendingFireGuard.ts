/**
 * Guards against duplicate virtual range leg fires (same step_idx re-opened after
 * `fired`, stale claim reclaim, or duplicate pending rows from re-planning).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type RangeLegBasketScope = {
  signalId: string
  brokerAccountId: string
  symbol: string
  stepIdx: number
}

export type RangePendingTpLockScope = {
  signalId: string
  brokerAccountId: string
  symbol: string
}

export async function hasTpTouchedLock(
  supabase: SupabaseClient,
  scope: RangePendingTpLockScope,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('range_pending_tp_locks')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .eq('symbol', scope.symbol)
  if (error) {
    console.warn(
      `[rangePendingFireGuard] tp-lock lookup failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${error.message}`,
    )
    return false
  }
  return (count ?? 0) > 0
}

export async function setTpTouchedLock(
  supabase: SupabaseClient,
  scope: RangePendingTpLockScope & {
    userId: string
    lockReason?: string
    triggerPrice?: number | null
    triggerSide?: 'bid' | 'ask' | null
  },
): Promise<void> {
  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from('range_pending_tp_locks')
    .upsert({
      signal_id: scope.signalId,
      user_id: scope.userId,
      broker_account_id: scope.brokerAccountId,
      symbol: scope.symbol,
      lock_reason: scope.lockReason ?? 'tp_touched',
      trigger_price: scope.triggerPrice ?? null,
      trigger_side: scope.triggerSide ?? null,
      touched_at: nowIso,
    }, {
      onConflict: 'signal_id,broker_account_id,symbol',
    })
  if (error) {
    console.warn(
      `[rangePendingFireGuard] tp-lock upsert failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${error.message}`,
    )
  }
}

export async function expireActiveRangeLegsForTpLock(
  supabase: SupabaseClient,
  scope: RangePendingTpLockScope,
  reason = 'tp_touched_lock',
): Promise<number> {
  const { data, error } = await supabase
    .from('range_pending_legs')
    .update({ status: 'expired', error_message: reason })
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .eq('symbol', scope.symbol)
    .in('status', ['pending', 'claimed'])
    .select('id')
  if (error) {
    console.warn(
      `[rangePendingFireGuard] tp-lock expiry failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${error.message}`,
    )
    return 0
  }
  return (data ?? []).length
}

/** True when this ladder rung already fired (broker market order was sent). */
export async function rangeStepAlreadyFired(
  supabase: SupabaseClient,
  scope: RangeLegBasketScope,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('range_pending_legs')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .eq('symbol', scope.symbol)
    .eq('step_idx', scope.stepIdx)
    .eq('status', 'fired')
  if (error) {
    console.warn(
      `[rangePendingFireGuard] consumed check failed signal=${scope.signalId} step=${scope.stepIdx}: ${error.message}`,
    )
    return false
  }
  return (count ?? 0) > 0
}

/** Cancel a duplicate active row when the same rung is already consumed. */
export async function cancelDuplicateActiveLeg(
  supabase: SupabaseClient,
  legId: string,
  scope: RangeLegBasketScope,
  reason = 'duplicate_pending_step_already_consumed',
): Promise<boolean> {
  if (!await rangeStepAlreadyFired(supabase, scope)) return false
  const { data } = await supabase
    .from('range_pending_legs')
    .update({ status: 'cancelled', error_message: reason })
    .eq('id', legId)
    .in('status', ['pending', 'claimed'])
    .select('id')
    .maybeSingle()
  return !!data
}

/** step_idx values that already have any row (including fired) for this basket. */
export async function loadExistingRangeStepIndices(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
  symbol: string,
): Promise<Set<number>> {
  const { data, error } = await supabase
    .from('range_pending_legs')
    .select('step_idx')
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .eq('symbol', symbol)
    .limit(500)
  if (error) {
    console.warn(`[rangePendingFireGuard] load steps failed signal=${signalId}: ${error.message}`)
    return new Set()
  }
  return new Set((data ?? []).map(r => Number((r as { step_idx: number }).step_idx)))
}

/**
 * Planned basket size from execution logs: range virtual rows + immediate order_send count.
 */
export async function loadBasketLegCap(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
): Promise<number | null> {
  const { data: ins } = await supabase
    .from('trade_execution_logs')
    .select('request_payload')
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .eq('action', 'virtual_pending_inserted')
    .eq('status', 'success')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const payload = (ins as { request_payload?: Record<string, unknown> } | null)?.request_payload
  const rangeRows = Number(payload?.rows ?? 0)
  if (!Number.isFinite(rangeRows) || rangeRows <= 0) return null

  const { count: immCount } = await supabase
    .from('trade_execution_logs')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .eq('action', 'order_send')
    .eq('status', 'success')

  const imm = immCount ?? 0
  return Math.max(1, rangeRows + imm)
}

export async function countOpenTradesForBasket(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('trades')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .eq('status', 'open')
  if (error) return 0
  return count ?? 0
}

/** True if this leg should not fire (already consumed or basket at cap). */
export async function shouldBlockVirtualLegFire(
  supabase: SupabaseClient,
  leg: { id: string; signal_id: string; broker_account_id: string; symbol: string; step_idx: number },
): Promise<{ block: boolean; reason?: string }> {
  const tpLockScope: RangePendingTpLockScope = {
    signalId: leg.signal_id,
    brokerAccountId: leg.broker_account_id,
    symbol: leg.symbol,
  }
  if (await hasTpTouchedLock(supabase, tpLockScope)) {
    await supabase
      .from('range_pending_legs')
      .update({ status: 'expired', error_message: 'tp_touched_lock' })
      .eq('id', leg.id)
      .in('status', ['pending', 'claimed'])
    return { block: true, reason: 'tp_touched_lock' }
  }

  const scope: RangeLegBasketScope = {
    signalId: leg.signal_id,
    brokerAccountId: leg.broker_account_id,
    symbol: leg.symbol,
    stepIdx: leg.step_idx,
  }
  if (await rangeStepAlreadyFired(supabase, scope)) {
    await cancelDuplicateActiveLeg(supabase, leg.id, scope)
    return { block: true, reason: 'step_already_fired' }
  }

  const cap = await loadBasketLegCap(supabase, leg.signal_id, leg.broker_account_id)
  if (cap != null) {
    const open = await countOpenTradesForBasket(supabase, leg.signal_id, leg.broker_account_id)
    if (open >= cap) {
      await cancelDuplicateActiveLeg(supabase, leg.id, scope, 'basket_leg_cap_reached')
      return { block: true, reason: 'basket_leg_cap_reached' }
    }
  }

  return { block: false }
}

/** Reconcile stale `claimed` rows — never blindly reset to `pending` if already fired. */
export async function reconcileStaleClaimedLegs(
  supabase: SupabaseClient,
  staleBeforeIso: string,
): Promise<{ cancelled: number; failed: number; reset: number }> {
  const stats = { cancelled: 0, failed: 0, reset: 0 }
  const { data, error } = await supabase
    .from('range_pending_legs')
    .select('id,signal_id,broker_account_id,symbol,step_idx,ticket')
    .eq('status', 'claimed')
    .lt('claimed_at', staleBeforeIso)
    .limit(200)
  if (error || !data?.length) return stats

  for (const row of data as Array<{
    id: string
    signal_id: string
    broker_account_id: string
    symbol: string
    step_idx: number
    ticket: string | null
  }>) {
    const tpLockScope: RangePendingTpLockScope = {
      signalId: row.signal_id,
      brokerAccountId: row.broker_account_id,
      symbol: row.symbol,
    }
    if (await hasTpTouchedLock(supabase, tpLockScope)) {
      const { data: expired } = await supabase
        .from('range_pending_legs')
        .update({ status: 'expired', error_message: 'tp_touched_lock' })
        .eq('id', row.id)
        .eq('status', 'claimed')
        .select('id')
        .maybeSingle()
      if (expired) stats.cancelled += 1
      continue
    }

    const scope: RangeLegBasketScope = {
      signalId: row.signal_id,
      brokerAccountId: row.broker_account_id,
      symbol: row.symbol,
      stepIdx: row.step_idx,
    }
    if (await rangeStepAlreadyFired(supabase, scope)) {
      const { data: dropped } = await supabase
        .from('range_pending_legs')
        .update({ status: 'cancelled', error_message: 'stale_claim_duplicate_consumed_step' })
        .eq('id', row.id)
        .eq('status', 'claimed')
        .select('id')
        .maybeSingle()
      if (dropped) stats.cancelled += 1
      continue
    }

    const { count: firedLogCount } = await supabase
      .from('trade_execution_logs')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'virtual_pending_fired')
      .eq('status', 'success')
      .contains('request_payload', { leg_id: row.id })

    if ((firedLogCount ?? 0) > 0) {
      await supabase
        .from('range_pending_legs')
        .update({
          status: 'fired',
          fired_at: new Date().toISOString(),
          ticket: row.ticket,
          claimed_at: null,
          claimed_by: null,
          error_message: null,
        })
        .eq('id', row.id)
        .eq('status', 'claimed')
      stats.cancelled += 1
      continue
    }

    const { data: reset } = await supabase
      .from('range_pending_legs')
      .update({ status: 'pending', claimed_at: null, claimed_by: null })
      .eq('id', row.id)
      .eq('status', 'claimed')
      .select('id')
      .maybeSingle()
    if (reset) stats.reset += 1
    else stats.failed += 1
  }

  return stats
}
