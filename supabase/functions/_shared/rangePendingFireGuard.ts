/**
 * Shared with worker/src/rangePendingFireGuard.ts — keep in sync.
 * Guards against duplicate virtual range leg fires.
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any

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
  supabase: SupabaseLike,
  scope: RangePendingTpLockScope,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("range_pending_tp_locks")
    .select("id", { count: "exact", head: true })
    .eq("signal_id", scope.signalId)
    .eq("broker_account_id", scope.brokerAccountId)
    .eq("symbol", scope.symbol)
  if (error) return false
  return (count ?? 0) > 0
}

export async function clearTpTouchedLock(
  supabase: SupabaseLike,
  scope: { signalId: string; brokerAccountId: string; symbol?: string },
): Promise<void> {
  let q = supabase
    .from("range_pending_tp_locks")
    .delete()
    .eq("signal_id", scope.signalId)
    .eq("broker_account_id", scope.brokerAccountId)
  if (scope.symbol) {
    q = q.eq("symbol", scope.symbol)
  }
  await q
}

export async function setTpTouchedLock(
  supabase: SupabaseLike,
  scope: RangePendingTpLockScope & {
    userId: string
    lockReason?: string
    triggerPrice?: number | null
    triggerSide?: "bid" | "ask" | null
  },
): Promise<void> {
  await supabase
    .from("range_pending_tp_locks")
    .upsert({
      signal_id: scope.signalId,
      user_id: scope.userId,
      broker_account_id: scope.brokerAccountId,
      symbol: scope.symbol,
      lock_reason: scope.lockReason ?? "tp_touched",
      trigger_price: scope.triggerPrice ?? null,
      trigger_side: scope.triggerSide ?? null,
      touched_at: new Date().toISOString(),
    }, {
      onConflict: "signal_id,broker_account_id,symbol",
    })
}

export async function expireActiveRangeLegsForTpLock(
  supabase: SupabaseLike,
  scope: RangePendingTpLockScope,
  reason = "tp_touched_lock",
): Promise<number> {
  const { data } = await supabase
    .from("range_pending_legs")
    .update({ status: "expired", error_message: reason })
    .eq("signal_id", scope.signalId)
    .eq("broker_account_id", scope.brokerAccountId)
    .eq("symbol", scope.symbol)
    .in("status", ["pending", "claimed"])
    .select("id")
  return (data ?? []).length
}

export async function rangeStepAlreadyFired(
  supabase: SupabaseLike,
  scope: RangeLegBasketScope,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("range_pending_legs")
    .select("id", { count: "exact", head: true })
    .eq("signal_id", scope.signalId)
    .eq("broker_account_id", scope.brokerAccountId)
    .eq("symbol", scope.symbol)
    .eq("step_idx", scope.stepIdx)
    .eq("status", "fired")
  if (error) return false
  return (count ?? 0) > 0
}

export async function cancelDuplicateActiveLeg(
  supabase: SupabaseLike,
  legId: string,
  scope: RangeLegBasketScope,
  reason = "duplicate_pending_step_already_consumed",
): Promise<boolean> {
  if (!await rangeStepAlreadyFired(supabase, scope)) return false
  const { data } = await supabase
    .from("range_pending_legs")
    .update({ status: "cancelled", error_message: reason })
    .eq("id", legId)
    .in("status", ["pending", "claimed"])
    .select("id")
    .maybeSingle()
  return !!data
}

export async function shouldBlockVirtualLegFire(
  supabase: SupabaseLike,
  leg: { id: string; signal_id: string; broker_account_id: string; symbol: string; step_idx: number },
  opts?: { layerTillClose?: boolean },
): Promise<{ block: boolean; reason?: string }> {
  const tpLockScope: RangePendingTpLockScope = {
    signalId: leg.signal_id,
    brokerAccountId: leg.broker_account_id,
    symbol: leg.symbol,
  }
  if (!opts?.layerTillClose && await hasTpTouchedLock(supabase, tpLockScope)) {
    await supabase
      .from("range_pending_legs")
      .update({ status: "expired", error_message: "tp_touched_lock" })
      .eq("id", leg.id)
      .in("status", ["pending", "claimed"])
    return { block: true, reason: "tp_touched_lock" }
  }

  const scope: RangeLegBasketScope = {
    signalId: leg.signal_id,
    brokerAccountId: leg.broker_account_id,
    symbol: leg.symbol,
    stepIdx: leg.step_idx,
  }
  if (await rangeStepAlreadyFired(supabase, scope)) {
    await cancelDuplicateActiveLeg(supabase, leg.id, scope)
    return { block: true, reason: "step_already_fired" }
  }

  const { data: ins } = await supabase
    .from("trade_execution_logs")
    .select("request_payload")
    .eq("signal_id", leg.signal_id)
    .eq("broker_account_id", leg.broker_account_id)
    .eq("action", "virtual_pending_inserted")
    .eq("status", "success")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const rangeRows = Number((ins as { request_payload?: { rows?: number } } | null)?.request_payload?.rows ?? 0)
  if (Number.isFinite(rangeRows) && rangeRows > 0) {
    const { count: immCount } = await supabase
      .from("trade_execution_logs")
      .select("id", { count: "exact", head: true })
      .eq("signal_id", leg.signal_id)
      .eq("broker_account_id", leg.broker_account_id)
      .eq("action", "order_send")
      .eq("status", "success")
    const cap = Math.max(1, rangeRows + (immCount ?? 0))
    const { count: openCount } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("signal_id", leg.signal_id)
      .eq("broker_account_id", leg.broker_account_id)
      .eq("status", "open")
    if ((openCount ?? 0) >= cap) {
      await cancelDuplicateActiveLeg(supabase, leg.id, scope, "basket_leg_cap_reached")
      return { block: true, reason: "basket_leg_cap_reached" }
    }
  }

  return { block: false }
}
