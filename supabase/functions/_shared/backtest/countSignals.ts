import type { SupabaseClient } from "npm:@supabase/supabase-js@2"

export async function countStoredBacktestSignals(
  supabase: SupabaseClient,
  userId: string,
  channelIds: string[],
  dateFrom: string,
  dateTo: string,
): Promise<number> {
  if (channelIds.length === 0) return 0
  const fromIso = new Date(dateFrom).toISOString()
  const toIso = new Date(dateTo + "T23:59:59.999Z").toISOString()
  const { count, error } = await supabase
    .from("backtest_channel_signals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("channel_id", channelIds)
    .gte("signal_at", fromIso)
    .lte("signal_at", toIso)
  if (error) throw new Error(error.message)
  return count ?? 0
}
