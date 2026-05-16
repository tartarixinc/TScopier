import type {
  BacktestRunConfig,
  BacktestSummary,
  EquityPoint,
  SimulatedTradeResult,
} from "./types.ts"

export interface PortfolioTradeInput extends SimulatedTradeResult {
  channelName: string
}

export function computeLotSize(
  config: BacktestRunConfig,
  equity: number,
  entry: number,
  sl: number | null,
): number {
  if (config.sizingMode === "fixed_lot") {
    return Math.max(0.01, config.fixedLot)
  }
  if (sl == null || !Number.isFinite(sl)) return Math.max(0.01, config.fixedLot)
  const riskAmount = equity * (config.riskPercent / 100)
  const slDist = Math.abs(entry - sl)
  if (slDist <= 0) return Math.max(0.01, config.fixedLot)
  const pipValue = 10
  const lots = riskAmount / (slDist * pipValue * 100)
  return Math.max(0.01, Math.round(lots * 100) / 100)
}

export function runPortfolioSimulation(
  config: BacktestRunConfig,
  trades: PortfolioTradeInput[],
): { equityCurve: EquityPoint[]; summary: BacktestSummary } {
  const sorted = [...trades].sort(
    (a, b) => a.signalAt.getTime() - b.signalAt.getTime(),
  )

  let equity = config.initialBalance
  let peak = equity
  const curve: EquityPoint[] = []
  const byChannel: BacktestSummary["byChannel"] = {}

  let wins = 0
  let losses = 0
  let breakevenExits = 0
  let tp1BeforeBe = 0
  let tp1BeforeSl = 0
  let allTpHits = 0
  let grossProfit = 0
  let grossLoss = 0
  let traded = 0

  const pushPoint = (ts: Date, openTrades: number) => {
    if (equity > peak) peak = equity
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0
    curve.push({
      ts,
      equity: Number(equity.toFixed(2)),
      balance: Number(equity.toFixed(2)),
      drawdownPct: Number(dd.toFixed(4)),
      openTrades,
    })
  }

  pushPoint(sorted[0]?.signalAt ?? new Date(config.dateFrom), 0)

  for (const t of sorted) {
    if (t.outcome === "skipped" || t.outcome === "no_data") continue
    traded++

    const sizedLot = computeLotSize(config, equity, t.entryPrice, t.sl)
    const scale = sizedLot / (t.lotSize || sizedLot)
    const pnl = t.pnl * scale

    equity += pnl
    if (pnl > 0) {
      wins++
      grossProfit += pnl
    } else if (pnl < 0) {
      losses++
      grossLoss += Math.abs(pnl)
    }

    if (t.outcome === "breakeven" || t.outcome === "tp_then_be") breakevenExits++
    if (t.outcome === "tp1_then_sl") tp1BeforeSl++
    if (t.outcome === "tp_then_be" && t.tpsHit >= 1) tp1BeforeBe++
    if (t.outcome === "all_tp_hit") allTpHits++

    const ch = byChannel[t.channelId] ?? {
      channelName: t.channelName,
      trades: 0,
      netPnl: 0,
      winRate: 0,
      wins: 0,
    }
    ch.trades++
    ch.netPnl += pnl
    if (pnl > 0) (ch as { wins: number }).wins += 1
    byChannel[t.channelId] = ch

    pushPoint(t.closedAt ?? t.signalAt, 0)
  }

  for (const ch of Object.values(byChannel)) {
    ch.netPnl = Number(ch.netPnl.toFixed(2))
    const w = (ch as { wins?: number }).wins ?? 0
    ch.winRate = ch.trades > 0 ? Number(((w / ch.trades) * 100).toFixed(1)) : 0
    delete (ch as { wins?: number }).wins
  }

  const netPnl = equity - config.initialBalance
  const returnPct = config.initialBalance > 0
    ? (netPnl / config.initialBalance) * 100
    : 0
  const maxDrawdownPct = curve.reduce((m, p) => Math.max(m, p.drawdownPct), 0)

  return {
    equityCurve: curve,
    summary: {
      totalSignals: trades.length,
      tradedSignals: traded,
      skippedSignals: trades.length - traded,
      wins,
      losses,
      breakevenExits,
      tp1BeforeBe,
      tp1BeforeSl,
      allTpHits,
      finalEquity: Number(equity.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2)),
      returnPct: Number(returnPct.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : null,
      winRate: traded > 0 ? Number(((wins / traded) * 100).toFixed(1)) : 0,
      byChannel,
    },
  }
}
