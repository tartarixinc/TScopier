import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { MassiveClient } from "../massiveApi.ts"
import { parseSignalRow } from "./parseSignal.ts"
import { runPortfolioSimulation } from "./portfolio.ts"
import { barsToMidPoints, quotesToMidPoints, simulateTradeOnSeries } from "./simulator.ts"
import { mapSymbolToMassive, timeframeToAgg } from "./symbolMap.ts"
import type { BacktestRunConfig, SimulatedTradeResult } from "./types.ts"

type BarCacheKey = string

export async function executeBacktestRun(
  supabase: SupabaseClient,
  massive: MassiveClient,
  runId: string,
  userId: string,
  config: BacktestRunConfig,
): Promise<void> {
  const updateProgress = async (pct: number, message: string) => {
    await supabase.from("backtest_runs").update({
      progress_pct: pct,
      progress_message: message,
      updated_at: new Date().toISOString(),
    }).eq("id", runId).eq("user_id", userId)
  }

  await supabase.from("backtest_runs").update({
    status: "running",
    started_at: new Date().toISOString(),
    progress_pct: 2,
    progress_message: "Loading signals…",
  }).eq("id", runId)

  const fromIso = new Date(config.dateFrom).toISOString()
  const toIso = new Date(config.dateTo + "T23:59:59.999Z").toISOString()

  const { data: channelRows } = await supabase
    .from("backtest_run_channels")
    .select("channel_id")
    .eq("run_id", runId)

  const channelIds = (channelRows ?? []).map((r) => r.channel_id as string)
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

  const { data: signalRows, error: sigErr } = await supabase
    .from("signals")
    .select("id, channel_id, created_at, parsed_data, status")
    .eq("user_id", userId)
    .in("channel_id", channelIds.length ? channelIds : ["00000000-0000-0000-0000-000000000000"])
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .in("status", ["parsed", "executed"])
    .order("created_at", { ascending: true })

  if (sigErr) throw new Error(sigErr.message)

  const signals = (signalRows ?? [])
    .map((row) => parseSignalRow(row, channelNames.get(row.channel_id) ?? "Channel"))
    .filter((s): s is NonNullable<typeof s> => s != null)

  await updateProgress(10, `Loaded ${signals.length} tradeable signals`)

  const fromMs = new Date(config.dateFrom).getTime()
  const toMs = new Date(config.dateTo + "T23:59:59.999Z").getTime()
  const { multiplier, timespan } = timeframeToAgg(config.timeframe)

  const barCache = new Map<BarCacheKey, ReturnType<typeof barsToMidPoints>>()
  const quoteCache = new Map<BarCacheKey, ReturnType<typeof quotesToMidPoints>>()

  const fetchSeries = async (symbol: string) => {
    const key = `${symbol}|${config.timeframe}|${config.executionMode}`
    if (config.executionMode === "tick_quotes") {
      if (quoteCache.has(key)) return quoteCache.get(key)!
      const mapped = mapSymbolToMassive(symbol)
      if (!mapped || mapped.assetClass !== "forex") {
        return barCache.get(key) ?? []
      }
      const fromNs = fromMs * 1_000_000
      const toNs = toMs * 1_000_000
      try {
        const quotes = await massive.getForexQuotes(mapped.massiveTicker, fromNs, toNs)
        const pts = quotesToMidPoints(quotes)
        quoteCache.set(key, pts)
        return pts
      } catch {
        const bars = await fetchBars(mapped.massiveTicker)
        const pts = barsToMidPoints(bars)
        barCache.set(key, pts)
        return pts
      }
    }
    if (barCache.has(key)) return barCache.get(key)!
    const mapped = mapSymbolToMassive(symbol)
    if (!mapped) return []
    const bars = await fetchBars(mapped.massiveTicker)
    const pts = barsToMidPoints(bars)
    barCache.set(key, pts)
    return pts
  }

  const fetchBars = async (ticker: string) => {
    return massive.getAggregates(ticker, multiplier, timespan, fromMs, toMs, { sort: "asc" })
  }

  const results: SimulatedTradeResult[] = []
  let i = 0
  for (const sig of signals) {
    i++
    if (i % 5 === 0) {
      await updateProgress(10 + Math.min(75, (i / Math.max(1, signals.length)) * 65), `Simulating ${i}/${signals.length}…`)
    }
    const series = await fetchSeries(sig.symbol)
    const lot = sig.lotSize ?? config.fixedLot
    const sim = simulateTradeOnSeries(sig, series, config.strategy, lot)
    results.push(sim)
  }

  await updateProgress(85, "Building portfolio…")

  const portfolioInput = results.map((r) => ({
    ...r,
    channelName: channelNames.get(r.channelId) ?? "Channel",
  }))
  const { equityCurve, summary } = runPortfolioSimulation(config, portfolioInput)

  await supabase.from("backtest_trades").delete().eq("run_id", runId)
  await supabase.from("backtest_equity_points").delete().eq("run_id", runId)

  if (results.length > 0) {
    const tradeRows = results.map((r) => ({
      run_id: runId,
      signal_id: r.signalId,
      channel_id: r.channelId,
      symbol: r.symbol,
      direction: r.direction,
      signal_at: r.signalAt.toISOString(),
      entry_price: r.entryPrice,
      sl: r.sl,
      tp_levels: r.tpLevels,
      lot_size: r.lotSize,
      outcome: r.outcome,
      tps_hit: r.tpsHit,
      exit_price: r.exitPrice,
      closed_at: r.closedAt?.toISOString() ?? null,
      pnl: r.pnl,
      pnl_r: r.pnlR,
      max_favorable_excursion: r.mfe,
      max_adverse_excursion: r.mae,
      details: r.details,
    }))
    for (let off = 0; off < tradeRows.length; off += 200) {
      await supabase.from("backtest_trades").insert(tradeRows.slice(off, off + 200))
    }
  }

  if (equityCurve.length > 0) {
    const eqRows = equityCurve.map((p) => ({
      run_id: runId,
      ts: p.ts.toISOString(),
      equity: p.equity,
      balance: p.balance,
      drawdown_pct: p.drawdownPct,
      open_trades: p.openTrades,
    }))
    for (let off = 0; off < eqRows.length; off += 500) {
      await supabase.from("backtest_equity_points").insert(eqRows.slice(off, off + 500))
    }
  }

  await supabase.from("backtest_runs").update({
    status: "completed",
    progress_pct: 100,
    progress_message: "Complete",
    summary,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", runId)
}
