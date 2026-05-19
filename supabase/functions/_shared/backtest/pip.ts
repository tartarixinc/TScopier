/**
 * @deprecated Import from `../signalPip.ts`. Re-exports for backtest edge code.
 */
import { computePipsFromSignalOutcome } from "../signalPip.ts"

export {
  normalizeSignalSymbol,
  getPipMultiplierForSymbol,
  signalPipPrice,
  roundSignalPips,
  roundSignalPips as roundBacktestPips,
  priceDeltaToPips,
  pipsToPriceOffset,
  computePipsFromSignalOutcome,
} from "../signalPip.ts"

export function computeTradePipPnl(input: {
  symbol: string
  direction: string
  entry: number
  exit: number | null
  outcome: string
  tpLevels: number[]
  tpsHit?: number
  sl?: number | null
}): number | null {
  return computePipsFromSignalOutcome({
    symbol: input.symbol,
    direction: input.direction,
    entry: input.entry,
    sl: input.sl ?? null,
    tpLevels: input.tpLevels,
    outcome: input.outcome,
    tpsHit: input.tpsHit ?? (input.outcome === "all_tp_hit" ? input.tpLevels.length : 0),
  })
}
