/**
 * Shared with worker/src/rangeLayerTillClose.ts — keep in sync.
 * Per-channel "layer till close" for virtual range pendings.
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any

export type RangeLayerBasketScope = {
  signalId: string
  brokerAccountId: string
  symbol: string
  userId?: string | null
}

export function isRangeLayerTillCloseEnabled(
  settings: Record<string, unknown> | null | undefined,
): boolean {
  if (!settings || typeof settings !== "object") return false
  return settings.range_layer_till_close === true
}

function resolveChannelManualSettings(
  broker: Record<string, unknown>,
  channelId: string | null,
): Record<string, unknown> {
  const fallback = (broker.manual_settings && typeof broker.manual_settings === "object"
    ? broker.manual_settings
    : {}) as Record<string, unknown>
  if (!channelId) return fallback
  const configs = broker.channel_trading_configs
  if (!configs || typeof configs !== "object" || Array.isArray(configs)) return fallback
  const key = channelId.trim().toLowerCase()
  for (const [k, v] of Object.entries(configs as Record<string, unknown>)) {
    if (k.toLowerCase() !== key) continue
    if (!v || typeof v !== "object" || Array.isArray(v)) break
    const ms = (v as Record<string, unknown>).manual_settings
    if (ms && typeof ms === "object" && !Array.isArray(ms)) {
      return { ...fallback, ...(ms as Record<string, unknown>) }
    }
    break
  }
  return fallback
}

export async function loadRangeLayerTillCloseForSignal(
  supabase: SupabaseLike,
  signalId: string,
  brokerAccountId: string,
): Promise<boolean> {
  const { data: signal } = await supabase
    .from("signals")
    .select("channel_id")
    .eq("id", signalId)
    .maybeSingle()
  const { data: broker } = await supabase
    .from("broker_accounts")
    .select("manual_settings, channel_trading_configs")
    .eq("id", brokerAccountId)
    .maybeSingle()
  if (!broker) return false
  const channelId = (signal as { channel_id?: string | null } | null)?.channel_id ?? null
  const manual = resolveChannelManualSettings(broker as Record<string, unknown>, channelId)
  return isRangeLayerTillCloseEnabled(manual)
}

async function countOpenTradesForBasket(
  supabase: SupabaseLike,
  signalId: string,
  brokerAccountId: string,
): Promise<number> {
  const { count } = await supabase
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("signal_id", signalId)
    .eq("broker_account_id", brokerAccountId)
    .eq("status", "open")
  return count ?? 0
}

async function deleteActivePendingLegs(
  supabase: SupabaseLike,
  signalId: string,
  brokerAccountId: string,
): Promise<number> {
  const { data } = await supabase
    .from("range_pending_legs")
    .delete()
    .eq("signal_id", signalId)
    .eq("broker_account_id", brokerAccountId)
    .in("status", ["pending", "claimed"])
    .select("id")
  return (data ?? []).length
}

export async function stopRangeLayeringUnlessEnabled(
  supabase: SupabaseLike,
  scope: RangeLayerBasketScope,
  reason: string,
): Promise<{ stopped: boolean; deleted: number }> {
  const layerTillClose = await loadRangeLayerTillCloseForSignal(
    supabase,
    scope.signalId,
    scope.brokerAccountId,
  )
  if (layerTillClose) return { stopped: false, deleted: 0 }

  const openCount = await countOpenTradesForBasket(
    supabase,
    scope.signalId,
    scope.brokerAccountId,
  )
  if (openCount <= 0) return { stopped: false, deleted: 0 }

  const deleted = await deleteActivePendingLegs(
    supabase,
    scope.signalId,
    scope.brokerAccountId,
  )
  if (scope.userId) {
    await supabase
      .from("range_pending_tp_locks")
      .upsert({
        signal_id: scope.signalId,
        user_id: scope.userId,
        broker_account_id: scope.brokerAccountId,
        symbol: scope.symbol,
        lock_reason: reason,
        touched_at: new Date().toISOString(),
      }, {
        onConflict: "signal_id,broker_account_id,symbol",
      })
  }
  return { stopped: true, deleted }
}
