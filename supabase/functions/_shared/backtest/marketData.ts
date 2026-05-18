import { MassiveClient, MassiveApiError, sanitizeMarketDataErrorMessage } from "../massiveApi.ts"
import type { PricePoint } from "./simulator.ts"
import { barsToMidPoints, quotesToMidPoints } from "./simulator.ts"
import { mapSymbolToMassive, timeframeToAgg } from "./symbolMap.ts"
import type { BacktestRunConfig, ParsedSignalForBacktest } from "./types.ts"

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
  rateLimitHits: number
}

function maxPagesForAgg(multiplier: number, timespan: "minute" | "hour" | "day"): number {
  if (timespan === "day") return 2
  if (timespan === "hour") return 3
  if (multiplier >= 15) return 3
  if (multiplier >= 5) return 4
  return 5
}

function signalWindowForSymbol(
  symbol: string,
  signals: ParsedSignalForBacktest[],
  configFromMs: number,
  configToMs: number,
): { fromMs: number; toMs: number } {
  const symSigs = signals.filter((s) => s.symbol === symbol)
  if (!symSigs.length) {
    return { fromMs: configFromMs, toMs: configToMs }
  }
  const minSig = Math.min(...symSigs.map((s) => s.signalAt.getTime()))
  const maxSig = Math.max(...symSigs.map((s) => s.signalAt.getTime()))
  const padBefore = 24 * 3_600_000
  const padAfter = 5 * 24 * 3_600_000
  return {
    fromMs: Math.max(configFromMs, minSig - padBefore),
    toMs: Math.min(configToMs, maxSig + padAfter),
  }
}

async function fetchBarsForSymbol(
  massive: MassiveClient,
  mapped: { massiveTicker: string; assetClass: string },
  multiplier: number,
  timespan: "minute" | "hour" | "day",
  fromMs: number,
  toMs: number,
): Promise<{ pts: PricePoint[]; apiCalls: number; log: string; rateLimited: boolean }> {
  const rangeLabel = `${new Date(fromMs).toISOString().slice(0, 10)}→${new Date(toMs).toISOString().slice(0, 10)}`
  try {
    const bars = await massive.getAggregates(
      mapped.massiveTicker,
      multiplier,
      timespan,
      fromMs,
      toMs,
      { sort: "asc", maxPages: maxPagesForAgg(multiplier, timespan) },
    )
    const pts = barsToMidPoints(bars)
    return {
      pts,
      apiCalls: 1,
      log: `${pts.length} bars (${mapped.massiveTicker}, ${rangeLabel})`,
      rateLimited: false,
    }
  } catch (e) {
    const status = e instanceof MassiveApiError ? e.status : 0
    const rateLimited = status === 429
    const short = rateLimited
      ? "rate limited — skipped (other symbols still run)"
      : sanitizeMarketDataErrorMessage(e instanceof Error ? e.message : String(e))
    return {
      pts: [],
      apiCalls: rateLimited ? 0 : 1,
      log: `fetch failed: ${short}`,
      rateLimited,
    }
  }
}

/**
 * Fetch OHLC or forex quotes from Massive for every symbol before simulation.
 * Per-symbol failures (including rate limits) do not abort the whole run.
 */
export async function preloadMarketData(
  massive: MassiveClient,
  symbols: string[],
  signals: ParsedSignalForBacktest[],
  config: BacktestRunConfig,
  configFromMs: number,
  configToMs: number,
  callsPerMinute = 5,
): Promise<PreloadedMarketData> {
  const { multiplier, timespan } = timeframeToAgg(config.timeframe)
  const seriesBySymbol = new Map<string, PricePoint[]>()
  const fetchLog: string[] = []
  let apiCalls = 0
  let rateLimitHits = 0
  const lowRatePlan = callsPerMinute <= 5

  for (const symbol of symbols) {
    const mapped = mapSymbolToMassive(symbol)
    if (!mapped) {
      fetchLog.push(`${symbol}: no Massive ticker mapping`)
      seriesBySymbol.set(symbol, [])
      continue
    }

    const { fromMs, toMs } = signalWindowForSymbol(symbol, signals, configFromMs, configToMs)
    if (fromMs >= toMs) {
      fetchLog.push(`${symbol}: invalid time window`)
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
        if (pts.length === 0) {
          const fallback = await fetchBarsForSymbol(massive, mapped, multiplier, timespan, fromMs, toMs)
          apiCalls += fallback.apiCalls
          pts = fallback.pts
          if (fallback.rateLimited) rateLimitHits++
          fetchLog.push(`${symbol}: ${fallback.log}`)
        }
      } catch (e) {
        const fallback = await fetchBarsForSymbol(massive, mapped, multiplier, timespan, fromMs, toMs)
        apiCalls += fallback.apiCalls
        pts = fallback.pts
        if (fallback.rateLimited) rateLimitHits++
        fetchLog.push(`${symbol}: quotes unavailable, ${fallback.log}`)
      }
    } else {
      const result = await fetchBarsForSymbol(massive, mapped, multiplier, timespan, fromMs, toMs)
      apiCalls += result.apiCalls
      pts = result.pts
      if (result.rateLimited) rateLimitHits++
      fetchLog.push(`${symbol}: ${result.log}`)
    }

    seriesBySymbol.set(symbol, pts)
  }

  return { seriesBySymbol, apiCalls, fetchLog, rateLimitHits }
}
