import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { MassiveClient } from "../massiveApi.ts"
import { loadBacktestSignals } from "./loadSignals.ts"
import { preloadMarketData } from "./marketData.ts"
import { runPortfolioSimulation } from "./portfolio.ts"
import { simulateTradeOnSeries } from "./simulator.ts"
import type { BacktestRunConfig, SimulatedTradeResult } from "./types.ts"

export interface BacktestRunContext {
  importWarnings?: string[]
}

export async function executeBacktestRun(
  supabase: SupabaseClient,
  massive: MassiveClient,
  runId: string,
  userId: string,
  config: BacktestRunConfig,
  ctx: BacktestRunContext = {},
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

  const loaded = await loadBacktestSignals(
    supabase,
    userId,
    channelIds,
    fromIso,
    toIso,
    channelNames,
    config.symbols,
  )
  const signals = loaded.signals

  const importWarnings = ctx.importWarnings ?? []

  const symbolFilter = (config.symbols ?? []).map((s) => String(s).trim().toUpperCase()).filter(Boolean)

  if (signals.length === 0) {
    const parts = [
      "No tradeable backtest signals in date range.",
      symbolFilter.length
        ? `Symbol filter: ${symbolFilter.join(", ")}. Clear symbol selection or run import first.`
        : "Connect Telegram, ensure the worker is online (WORKER_URL), and run again to import history.",
    ]
    if (importWarnings.length) {
      parts.push(`Import: ${importWarnings.slice(0, 3).join("; ")}`)
    }
    const hint = parts.join(" ")
    await updateProgress(100, hint)
    await supabase.from("backtest_runs").update({
      status: "completed",
      progress_pct: 100,
      progress_message: hint,
      summary: {
        totalSignals: 0,
        tradedSignals: 0,
        skippedSignals: 0,
        wins: 0,
        losses: 0,
        breakevenExits: 0,
        tp1BeforeBe: 0,
        tp1BeforeSl: 0,
        allTpHits: 0,
        finalEquity: config.initialBalance,
        netPnl: 0,
        returnPct: 0,
        maxDrawdownPct: 0,
        profitFactor: null,
        winRate: 0,
        byChannel: {},
        message: hint,
        signalSource: "backtest_channel_signals",
        rawParsedCount: loaded.rawParsedCount,
        massiveApiCalls: 0,
        importWarnings,
      },
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", runId)
    return
  }

  await updateProgress(
    10,
    `Loaded ${signals.length} tradeable signal(s) — fetching Massive market data…`,
  )

  const fromMs = new Date(config.dateFrom).getTime()
  const toMs = new Date(config.dateTo + "T23:59:59.999Z").getTime()
  const symbolsNeeded = [...new Set(signals.map((s) => s.symbol))]

  const callsPerMinute = massive.callsPerMinute
  const estMinutes = Math.max(1, Math.ceil(symbolsNeeded.length / Math.max(1, callsPerMinute)))
  await updateProgress(
    12,
    `Massive: ~${symbolsNeeded.length} symbol(s), ${callsPerMinute}/min limit (~${estMinutes} min)…`,
  )

  const { seriesBySymbol, apiCalls, fetchLog } = await preloadMarketData(
    massive,
    symbolsNeeded,
    config,
    fromMs,
    toMs,
    callsPerMinute,
  )

  console.log("[backtest-run] Massive preload:", { apiCalls, fetchLog })

  await updateProgress(
    20,
    `Massive: ${apiCalls} API request(s) · ${symbolsNeeded.length} symbol(s)`,
  )

  const results: SimulatedTradeResult[] = []
  let i = 0
  for (const sig of signals) {
    i++
    const series = seriesBySymbol.get(sig.symbol) ?? []
    if (i === 1 || i % 5 === 0 || i === signals.length) {
      await updateProgress(
        20 + Math.min(65, (i / Math.max(1, signals.length)) * 65),
        `Simulating ${i}/${signals.length} (${sig.symbol}, ${series.length} points)…`,
      )
    }
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

  summary.massiveApiCalls = apiCalls
  summary.importWarnings = importWarnings.length ? importWarnings : undefined
  summary.signalSource = "backtest_channel_signals"
  summary.rawParsedCount = loaded.rawParsedCount

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

  const noDataCount = results.filter((r) => r.outcome === "no_data").length
  const progressMsg = noDataCount > 0
    ? `Complete · ${noDataCount} signal(s) had no market data (check Massive plan / symbol mapping)`
    : `Complete · Massive ${apiCalls} request(s)`

  await supabase.from("backtest_runs").update({
    status: "completed",
    progress_pct: 100,
    progress_message: progressMsg,
    summary,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", runId)
}
