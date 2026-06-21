import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import type { BacktestRunConfig } from "./types.ts"
import { buildTpslSummary } from "./tpslSummary.ts"
import { dbTradeToSimulated, type DbBacktestTradeRow } from "./tradeRows.ts"

export async function recalculateRunSummary(
  supabase: SupabaseClient,
  runId: string,
  userId: string,
  config: BacktestRunConfig,
): Promise<void> {
  const { data: trades, error: tradesErr } = await supabase
    .from("backtest_trades")
    .select("*")
    .eq("run_id", runId)
    .order("signal_at")
  if (tradesErr) throw new Error(tradesErr.message)

  const { data: run, error: runErr } = await supabase
    .from("backtest_runs")
    .select("summary")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle()
  if (runErr) throw new Error(runErr.message)
  if (!run) throw new Error("Run not found")

  const channelIds = [...new Set(
    (trades ?? [])
      .map((t) => (t as DbBacktestTradeRow).channel_id)
      .filter(Boolean) as string[],
  )]
  const channelNames = new Map<string, string>()
  if (channelIds.length > 0) {
    const { data: chMeta } = await supabase
      .from("telegram_channels")
      .select("id, display_name")
      .in("id", channelIds)
    for (const ch of chMeta ?? []) {
      channelNames.set(ch.id as string, (ch.display_name as string) || "Channel")
    }
  }

  const results = (trades ?? []).map((row) => dbTradeToSimulated(row as DbBacktestTradeRow))
  const prevSummary = (run.summary ?? {}) as Record<string, unknown>
  const summary = buildTpslSummary(config, results, channelNames)

  await supabase.from("backtest_runs").update({
    summary: {
      ...summary,
      marketDataApiCalls: prevSummary.marketDataApiCalls ?? prevSummary.massiveApiCalls ?? summary.marketDataApiCalls,
      massiveApiCalls: prevSummary.massiveApiCalls ?? prevSummary.marketDataApiCalls ?? summary.massiveApiCalls,
      brokerAccountId: prevSummary.brokerAccountId,
      brokerLabel: prevSummary.brokerLabel,
      importWarnings: prevSummary.importWarnings,
      signalSource: prevSummary.signalSource ?? summary.signalSource,
      rawParsedCount: prevSummary.rawParsedCount,
    },
    updated_at: new Date().toISOString(),
  }).eq("id", runId).eq("user_id", userId)
}
