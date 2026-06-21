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

export type OpenBasketTrade = {
  entry_price: number
  lot_size: number
}

export async function loadOpenTradesForBasket(
  supabase: SupabaseLike,
  signalId: string,
  brokerAccountId: string,
): Promise<OpenBasketTrade[]> {
  const { data, error } = await supabase
    .from("trades")
    .select("entry_price, lot_size")
    .eq("signal_id", signalId)
    .eq("broker_account_id", brokerAccountId)
    .eq("status", "open")
  if (error || !data?.length) return []

  const out: OpenBasketTrade[] = []
  for (const row of data) {
    const entry = Number((row as { entry_price?: number | null }).entry_price)
    const lots = Number((row as { lot_size?: number | null }).lot_size)
    if (Number.isFinite(entry) && entry > 0 && Number.isFinite(lots) && lots > 0) {
      out.push({ entry_price: entry, lot_size: lots })
    }
  }
  return out
}

/** True when the basket's open legs are net in profit at the live quote. */
export function basketInProfitAtQuote(
  openTrades: Array<{ entry_price: number; lot_size: number }>,
  isBuy: boolean,
  bid: number,
  ask: number,
): boolean {
  if (!openTrades.length) return false
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false

  let totalLots = 0
  let weightedEntry = 0
  for (const trade of openTrades) {
    totalLots += trade.lot_size
    weightedEntry += trade.entry_price * trade.lot_size
  }
  if (totalLots <= 0) return false

  const avgEntry = weightedEntry / totalLots
  if (isBuy) return bid >= avgEntry
  return ask <= avgEntry
}

export async function shouldBlockVirtualLegFire(
  supabase: SupabaseLike,
  leg: { id: string; signal_id: string; broker_account_id: string; symbol: string; step_idx: number },
  opts?: {
    layerTillClose?: boolean
    quote?: { bid: number; ask: number }
    isBuy?: boolean
  },
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
  let cap: number | null = null
  if (Number.isFinite(rangeRows) && rangeRows > 0) {
    const { count: immCount } = await supabase
      .from("trade_execution_logs")
      .select("id", { count: "exact", head: true })
      .eq("signal_id", leg.signal_id)
      .eq("broker_account_id", leg.broker_account_id)
      .eq("action", "order_send")
      .eq("status", "success")
    cap = Math.max(1, rangeRows + (immCount ?? 0))
  }

  const needOpenTrades = cap != null || (opts?.quote != null && opts.isBuy != null)
  const openTrades = needOpenTrades
    ? await loadOpenTradesForBasket(supabase, leg.signal_id, leg.broker_account_id)
    : []

  if (cap != null && openTrades.length >= cap) {
    await cancelDuplicateActiveLeg(supabase, leg.id, scope, "basket_leg_cap_reached")
    return { block: true, reason: "basket_leg_cap_reached" }
  }

  if (opts?.quote != null && opts.isBuy != null) {
    if (basketInProfitAtQuote(openTrades, opts.isBuy, opts.quote.bid, opts.quote.ask)) {
      return { block: true, reason: "basket_in_profit" }
    }
  }

  return { block: false }
}
