import { computePipsFromSignalOutcome } from "./pip.ts"
import type { BacktestRunConfig, BacktestSummary, SimulatedTradeResult } from "./types.ts"

export function tradePipPnlFromSim(r: SimulatedTradeResult): number | null {
  if (r.pipPnl != null && Number.isFinite(r.pipPnl)) return r.pipPnl
  return computePipsFromSignalOutcome({
    symbol: r.symbol,
    direction: r.direction,
    entry: r.entryPrice,
    sl: r.sl,
    tpLevels: r.tpLevels,
    outcome: r.outcome,
    tpsHit: r.tpsHit,
  })
}

export function buildTpslSummary(
  config: BacktestRunConfig,
  results: SimulatedTradeResult[],
  channelNames: Map<string, string>,
): BacktestSummary {
  let wins = 0
  let losses = 0
  let breakevenExits = 0
  let tp1BeforeBe = 0
  let tp1BeforeSl = 0
  let allTpHits = 0
  let skippedSignals = 0
  let netPnl = 0
  let totalPips = 0
  const byChannel: BacktestSummary["byChannel"] = {}
  const channelWins = new Map<string, number>()

  for (const r of results) {
    if (r.outcome === "skipped" || r.outcome === "no_data") {
      skippedSignals++
      continue
    }

    const pips = tradePipPnlFromSim(r)
    if (pips != null) {
      netPnl += r.pnl
      totalPips += pips
      if (pips > 0) {
        wins++
        channelWins.set(r.channelId, (channelWins.get(r.channelId) ?? 0) + 1)
      } else if (pips < 0) losses++
    }

    if (r.outcome === "breakeven" || r.outcome === "tp_then_be") breakevenExits++
    if (r.outcome === "tp1_then_sl" || r.outcome === "tp_then_be") tp1BeforeSl++
    if (r.outcome === "tp1_then_sl" && r.tpsHit >= 1) tp1BeforeBe++
    if (r.outcome === "all_tp_hit") allTpHits++

    const chName = channelNames.get(r.channelId) ?? "Channel"
    const ch = byChannel[r.channelId] ?? {
      channelName: chName,
      trades: 0,
      netPnl: 0,
      winRate: 0,
    }
    ch.trades++
    ch.netPnl += r.pnl
    byChannel[r.channelId] = ch
  }

  for (const [channelId, ch] of Object.entries(byChannel)) {
    const w = channelWins.get(channelId) ?? 0
    ch.winRate = ch.trades > 0 ? w / ch.trades : 0
  }

  const tradedSignals = results.length - skippedSignals
  const winRate = tradedSignals > 0 ? wins / tradedSignals : 0

  return {
    totalSignals: results.length,
    tradedSignals,
    skippedSignals,
    wins,
    losses,
    breakevenExits,
    tp1BeforeBe,
    tp1BeforeSl,
    allTpHits,
    finalEquity: config.initialBalance,
    netPnl,
    returnPct: 0,
    maxDrawdownPct: 0,
    profitFactor: null,
    winRate,
    totalPips,
    byChannel,
    message: "TP/SL backtest (no portfolio simulation)",
  }
}
