import type { BacktestTimeframe } from "./types.ts"

/** @deprecated Massive-only — use toFxsocketTimeframe from fxsocketMarketData.ts */
export function timeframeToAgg(timeframe: string): { multiplier: number; timespan: "minute" | "hour" | "day" } {
  switch (timeframe) {
    case "5m": return { multiplier: 5, timespan: "minute" }
    case "15m": return { multiplier: 15, timespan: "minute" }
    case "1h": return { multiplier: 1, timespan: "hour" }
    case "1d": return { multiplier: 1, timespan: "day" }
    default: return { multiplier: 1, timespan: "minute" }
  }
}

export function isBacktestTimeframe(v: string): v is BacktestTimeframe {
  return v === "1m" || v === "5m" || v === "15m" || v === "1h" || v === "1d"
}
