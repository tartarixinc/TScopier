import { MassiveClient } from "../massiveApi.ts"
import type { PricePoint } from "./simulator.ts"
import { barsToMidPoints, quotesToMidPoints } from "./simulator.ts"
import { mapSymbolToMassive, timeframeToAgg } from "./symbolMap.ts"
import type { BacktestRunConfig } from "./types.ts"

/** Quotes API uses `C:EUR-USD`; aggregates use `C:EURUSD`. */
export function toMassiveQuoteTicker(massiveTicker: string): string {
  if (massiveTicker.startsWith("C:")) {
    const pair = massiveTicker.slice(2)
    if (pair.length === 6 && !pair.includes("-")) {
      return `C:${pair.slice(0, 3)}-${pair.slice(3)}`
    }
  }
  return massiveTicker
}

export interface PreloadedMarketData {
  seriesBySymbol: Map<string, PricePoint[]>
  apiCalls: number
  fetchLog: string[]
}

/**
 * Fetch OHLC or forex quotes from Massive for every symbol before simulation.
 * Always uses aggregates for crypto/indices; forex tick mode tries quotes first.
 */
export async function preloadMarketData(
  massive: MassiveClient,
  symbols: string[],
  config: BacktestRunConfig,
  fromMs: number,
  toMs: number,
  callsPerMinute = 5,
): Promise<PreloadedMarketData> {
  const { multiplier, timespan } = timeframeToAgg(config.timeframe)
  const seriesBySymbol = new Map<string, PricePoint[]>()
  const fetchLog: string[] = []
  let apiCalls = 0
  const lowRatePlan = callsPerMinute <= 5

  for (const symbol of symbols) {
    const mapped = mapSymbolToMassive(symbol)
    if (!mapped) {
      fetchLog.push(`${symbol}: no Massive ticker mapping`)
      seriesBySymbol.set(symbol, [])
      continue
    }

    let pts: PricePoint[] = []
    const wantsQuotes = config.executionMode === "tick_quotes" && mapped.assetClass === "forex"
    const useQuotes = wantsQuotes && !lowRatePlan

    if (wantsQuotes && lowRatePlan) {
      fetchLog.push(`${symbol}: tick quotes skipped (plan ≤${callsPerMinute}/min — using OHLC bars)`)
    }

    if (useQuotes) {
      const quoteTicker = toMassiveQuoteTicker(mapped.massiveTicker)
      try {
        const quotes = await massive.getForexQuotes(
          quoteTicker,
          fromMs * 1_000_000,
          toMs * 1_000_000,
          { maxPages: 2 },
        )
        apiCalls += 1
        pts = quotesToMidPoints(quotes)
        fetchLog.push(`${symbol}: ${pts.length} quotes (${quoteTicker})`)
        if (pts.length === 0) throw new Error("empty quotes")
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        fetchLog.push(`${symbol}: quotes failed (${msg}), using bars`)
        const bars = await massive.getAggregates(
          mapped.massiveTicker,
          multiplier,
          timespan,
          fromMs,
          toMs,
          { sort: "asc", maxPages: 8 },
        )
        apiCalls += 1
        pts = barsToMidPoints(bars)
        fetchLog.push(`${symbol}: ${pts.length} bars (${mapped.massiveTicker})`)
      }
    } else {
      const bars = await massive.getAggregates(
        mapped.massiveTicker,
        multiplier,
        timespan,
        fromMs,
        toMs,
        { sort: "asc", maxPages: 8 },
      )
      apiCalls += 1
      pts = barsToMidPoints(bars)
      fetchLog.push(`${symbol}: ${pts.length} bars (${mapped.massiveTicker})`)
    }

    seriesBySymbol.set(symbol, pts)
  }

  return { seriesBySymbol, apiCalls, fetchLog }
}
