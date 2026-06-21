/**
 * Clear channel_active_trade_params when a channel+symbol basket is fully flat.
 * Keep in sync with worker/src/channelActiveTradeParams.ts.
 */

import { symbolsCompatibleForBasket } from "./basketModFollowUp.ts"

// deno-lint-ignore no-explicit-any
type SupabaseLike = any

export type ClearChannelActiveParamsResult = {
  cleared: boolean
  deletedSymbols: string[]
}

export async function channelHasOpenActivityForChannelSymbol(
  supabase: SupabaseLike,
  args: {
    userId: string
    channelId: string
    symbolHint: string
  },
): Promise<boolean> {
  const { data: sigs, error: sigErr } = await supabase
    .from("signals")
    .select("id")
    .eq("user_id", args.userId)
    .eq("channel_id", args.channelId)
    .limit(2000)
  if (sigErr || !sigs?.length) return false

  const signalIds = sigs.map((r: { id: string }) => r.id)

  const { data: trades } = await supabase
    .from("trades")
    .select("symbol")
    .eq("user_id", args.userId)
    .in("status", ["open", "pending"])
    .in("signal_id", signalIds)
    .limit(500)
  if (
    (trades ?? []).some((t: { symbol: string }) =>
      symbolsCompatibleForBasket(args.symbolHint, t.symbol),
    )
  ) {
    return true
  }

  const { data: pending } = await supabase
    .from("range_pending_legs")
    .select("symbol")
    .eq("user_id", args.userId)
    .in("signal_id", signalIds)
    .in("status", ["pending", "claimed"])
    .limit(500)
  if (
    (pending ?? []).some((l: { symbol: string }) =>
      symbolsCompatibleForBasket(args.symbolHint, l.symbol),
    )
  ) {
    return true
  }

  const { data: entryPending } = await supabase
    .from("signal_entry_pending_orders")
    .select("symbol")
    .in("signal_id", signalIds)
    .eq("status", "broker_pending")
    .limit(500)
  return (entryPending ?? []).some((r: { symbol: string }) =>
    symbolsCompatibleForBasket(args.symbolHint, r.symbol),
  )
}

export async function clearChannelActiveTradeParamsWhenFlat(
  supabase: SupabaseLike,
  args: {
    userId: string
    channelId: string
    symbolHint: string
  },
): Promise<ClearChannelActiveParamsResult> {
  const hasActivity = await channelHasOpenActivityForChannelSymbol(supabase, args)
  if (hasActivity) {
    return { cleared: false, deletedSymbols: [] }
  }

  const { data: rows, error } = await supabase
    .from("channel_active_trade_params")
    .select("symbol")
    .eq("user_id", args.userId)
    .eq("channel_id", args.channelId)
  if (error) {
    console.warn(`[channelActiveTradeParams] clear load failed: ${error.message}`)
    return { cleared: false, deletedSymbols: [] }
  }

  const toDelete = (rows ?? []).filter((r: { symbol: string }) =>
    symbolsCompatibleForBasket(args.symbolHint, r.symbol),
  )
  if (!toDelete.length) {
    return { cleared: false, deletedSymbols: [] }
  }

  const deletedSymbols: string[] = []
  for (const row of toDelete) {
    const sym = row.symbol
    const { error: delErr } = await supabase
      .from("channel_active_trade_params")
      .delete()
      .eq("user_id", args.userId)
      .eq("channel_id", args.channelId)
      .eq("symbol", sym)
    if (!delErr) {
      deletedSymbols.push(sym)
    } else {
      console.warn(`[channelActiveTradeParams] delete ${sym} failed: ${delErr.message}`)
    }
  }

  if (deletedSymbols.length) {
    console.log(
      `[channelActiveTradeParams] cleared channel=${args.channelId}`
      + ` symbol_hint=${args.symbolHint} deleted=${deletedSymbols.join(",")}`,
    )
  }

  return { cleared: deletedSymbols.length > 0, deletedSymbols }
}
