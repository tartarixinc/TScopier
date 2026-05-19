import type { MassiveBar, MassiveQuote } from "../massiveApi.ts"
import { computePipsFromSignalOutcome } from "./pip.ts"
import type {
  BacktestStrategyConfig,
  ParsedSignalForBacktest,
  SimulatedTradeResult,
  TradeOutcome,
} from "./types.ts"

export interface PricePoint {
  ts: number
  bid: number
  ask: number
  mid: number
}

/** OHLC bar → bid/ask envelope for conservative intrabar SL/TP checks. */
export function barsToMidPoints(bars: MassiveBar[]): PricePoint[] {
  return bars.map((b) => ({
    ts: b.t,
    bid: b.l,
    ask: b.h,
    mid: b.c,
  }))
}

/** Trim shared symbol series to the window needed for one signal (faster than scanning full history). */
export function sliceSeriesForSignal(
  series: PricePoint[],
  signalAt: Date,
  maxAfterMs = 5 * 86_400_000,
): PricePoint[] {
  if (!series.length) return series
  const start = signalAt.getTime() - 60_000
  const end = signalAt.getTime() + maxAfterMs
  let i = 0
  while (i < series.length && series[i]!.ts < start) i++
  let j = i
  while (j < series.length && series[j]!.ts <= end) j++
  return series.slice(i, j)
}

export function quotesToMidPoints(quotes: MassiveQuote[]): PricePoint[] {
  return quotes
    .filter((q) => Number.isFinite(q.bid_price) && Number.isFinite(q.ask_price))
    .map((q) => ({
      ts: Math.floor(q.participant_timestamp / 1_000_000),
      bid: q.bid_price,
      ask: q.ask_price,
      mid: (q.bid_price + q.ask_price) / 2,
    }))
    .sort((a, b) => a.ts - b.ts)
}

function executionPrice(direction: "buy" | "sell", side: "entry" | "exit", p: PricePoint): number {
  if (direction === "buy") return side === "entry" ? p.ask : p.bid
  return side === "entry" ? p.bid : p.ask
}

function hitLevel(
  direction: "buy" | "sell",
  level: number,
  p: PricePoint,
  kind: "tp" | "sl",
): boolean {
  if (direction === "buy") {
    if (kind === "tp") return p.ask >= level
    return p.bid <= level
  }
  if (kind === "tp") return p.bid <= level
  return p.ask >= level
}

export function simulateTradeOnSeries(
  signal: ParsedSignalForBacktest,
  series: PricePoint[],
  strategy: BacktestStrategyConfig,
  lotSize: number,
  pipValuePerLot = 10,
): SimulatedTradeResult {
  const base: SimulatedTradeResult = {
    signalId: signal.signalId,
    copierSignalId: signal.copierSignalId,
    channelId: signal.channelId,
    symbol: signal.symbol,
    direction: signal.direction,
    signalAt: signal.signalAt,
    entryPrice: signal.entryPrice,
    sl: signal.sl,
    tpLevels: [...signal.tpLevels],
    lotSize,
    outcome: "no_data",
    tpsHit: 0,
    exitPrice: null,
    closedAt: null,
    pnl: 0,
    pipPnl: null,
    pnlR: null,
    mfe: 0,
    mae: 0,
    details: {},
  }

  if (!series.length || signal.tpLevels.length === 0 && signal.sl == null) {
    base.outcome = "skipped"
    return base
  }

  const signalMs = signal.signalAt.getTime()
  const window = series.filter((p) => p.ts >= signalMs - 60_000)
  if (!window.length) return base

  let entryIdx = window.findIndex((p) => p.ts >= signalMs)
  if (entryIdx < 0) entryIdx = 0
  const entryPx = signal.entryPrice > 0
    ? signal.entryPrice
    : executionPrice(signal.direction, "entry", window[entryIdx]!)
  if (!(signal.entryPrice > 0)) {
    base.entryPrice = entryPx
    base.details.marketEntry = true
  }

  let sl = signal.sl
  let tps = [...signal.tpLevels].sort((a, b) =>
    signal.direction === "buy" ? a - b : b - a,
  )
  let tpIdx = 0
  let beActive = false
  let remainingFraction = 1
  let realizedPnl = 0
  let mfe = 0
  let mae = 0
  let lastTs: number | null = null

  const riskDistance = sl != null ? Math.abs(entryPx - sl) : null
  const partialFrac = strategy.partialClosePerTp > 0
    ? Math.min(1, strategy.partialClosePerTp)
    : (tps.length > 0 ? 1 / tps.length : 1)

  for (let i = entryIdx; i < window.length; i++) {
    const p = window[i]!
    lastTs = p.ts
    const mark = executionPrice(signal.direction, "exit", p)
    const move = signal.direction === "buy" ? mark - entryPx : entryPx - mark
    mfe = Math.max(mfe, move)
    mae = Math.max(mae, -move)

    const levels: Array<{ kind: "tp" | "sl" | "be"; price: number }> = []
    if (sl != null) levels.push({ kind: beActive ? "be" : "sl", price: beActive ? entryPx : sl })
    if (tpIdx < tps.length) levels.push({ kind: "tp", price: tps[tpIdx]! })

    const order = strategy.intrabarPriority === "tp_first"
      ? ["tp", "sl", "be"]
      : ["sl", "be", "tp"]

    for (const kind of order) {
      const lvl = levels.find((l) => l.kind === kind)
      if (!lvl) continue
      if (!hitLevel(signal.direction, lvl.price, p, kind === "tp" ? "tp" : "sl")) continue

      if (kind === "tp") {
        // Multiple TPs can trigger on the same candle (TelegramBacktester behavior).
        let hitAnyTp = false
        while (tpIdx < tps.length) {
          const tpPrice = tps[tpIdx]!
          if (!hitLevel(signal.direction, tpPrice, p, "tp")) break

          const closeFrac = Math.min(remainingFraction, partialFrac)
          const legPnl = moveAtPrice(signal.direction, entryPx, tpPrice, closeFrac, lotSize, pipValuePerLot)
          realizedPnl += legPnl
          remainingFraction -= closeFrac
          tpIdx += 1
          base.tpsHit = tpIdx
          hitAnyTp = true

          const events = Array.isArray(base.details.tpEvents)
            ? (base.details.tpEvents as Array<{ index: number; price: number; ts: number }>)
            : []
          events.push({ index: tpIdx, price: tpPrice, ts: p.ts })
          base.details.tpEvents = events

          if (strategy.breakevenAfterTp > 0 && tpIdx >= strategy.breakevenAfterTp) {
            beActive = true
            sl = entryPx
          }

          if (tpIdx >= tps.length) {
            return finalize(
              base, outcomeFromTps(base.tpsHit, tps.length, beActive), tpPrice, p.ts,
              realizedPnl, tps, riskDistance, mfe, mae, { beActive },
            )
          }
          if (remainingFraction <= 0.001) {
            return finalize(
              base, "all_tp_hit", tpPrice, p.ts,
              realizedPnl, tps, riskDistance, mfe, mae, {},
            )
          }
        }
        if (hitAnyTp) break
      }

      if (kind === "sl" || kind === "be") {
        const out: TradeOutcome = beActive || kind === "be"
          ? (base.tpsHit > 0 ? "tp_then_be" : "breakeven")
          : (base.tpsHit >= 1 ? "tp1_then_sl" : "sl_before_tp")
        const closePnl = moveAtPrice(signal.direction, entryPx, lvl.price, remainingFraction, lotSize, pipValuePerLot)
        return finalize(
          base, out, lvl.price, p.ts,
          realizedPnl + closePnl,
          tps, riskDistance, mfe, mae, { beActive },
        )
      }
    }
  }

  base.outcome = "open"
  base.mfe = mfe
  base.mae = mae
  base.pnl = realizedPnl
  if (lastTs) base.details.lastMarkTs = lastTs
  return base
}

function outcomeFromTps(hit: number, total: number, beActive: boolean): TradeOutcome {
  if (hit >= total) return "all_tp_hit"
  if (beActive && hit > 0) return "tp_then_be"
  return "tp1_then_sl"
}

function moveAtPrice(
  direction: "buy" | "sell",
  entry: number,
  exit: number,
  fraction: number,
  lot: number,
  pipValue: number,
): number {
  const pts = direction === "buy" ? exit - entry : entry - exit
  return pts * lot * pipValue * 100 * fraction
}

function finalize(
  base: SimulatedTradeResult,
  outcome: TradeOutcome,
  exitPrice: number,
  closedMs: number,
  pnl: number,
  tpLevels: number[],
  riskDistance: number | null,
  mfe: number,
  mae: number,
  details: Record<string, unknown>,
): SimulatedTradeResult {
  const pipPnl = computePipsFromSignalOutcome({
    symbol: base.symbol,
    direction: base.direction,
    entry: base.entryPrice,
    sl: base.sl,
    tpLevels,
    outcome,
    tpsHit: base.tpsHit,
  })

  return {
    ...base,
    outcome,
    exitPrice,
    closedAt: new Date(closedMs),
    pnl,
    pipPnl,
    pnlR: riskDistance && riskDistance > 0
      ? pnl / (riskDistance * base.lotSize * 10)
      : null,
    mfe,
    mae,
    details: { ...base.details, ...details, pipPnl: Number.isFinite(pipPnl) ? pipPnl : null },
  }
}
