import { FxsocketApiError, type FxsocketClient } from "../fxsocketClient.ts"
import {
  fxsocketBarsToMidPoints,
  fxsocketTicksToMidPoints,
  fxsocketMarketQueryRange,
  resolveBrokerSymbol,
  sanitizeMarketDataErrorMessage,
  isRetriableMarketDataError,
  toFxsocketTimeframe,
} from "./fxsocketMarketData.ts"
import type { BacktestBrokerContext } from "./resolveBacktestBroker.ts"
import type { PricePoint } from "./simulator.ts"
import type { BacktestRunConfig, ParsedSignalForBacktest } from "./types.ts"

export interface PreloadedMarketData {
  seriesBySymbol: Map<string, PricePoint[]>
  apiCalls: number
  fetchLog: string[]
  fetchFailures: number
  brokerContext: BacktestBrokerContext
  utcOffsetSeconds: number
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

export async function fetchUtcOffsetSeconds(fx: FxsocketClient, accountId: string): Promise<number> {
  try {
    const tz = await fx.serverTimezone(accountId)
    const offset = Number(tz.utcOffsetSeconds ?? tz.utc_offset_seconds ?? 0)
    return Number.isFinite(offset) ? offset : 0
  } catch {
    return 0
  }
}

export async function fetchBarsForSymbol(
  fx: FxsocketClient,
  ctx: BacktestBrokerContext,
  brokerSymbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number,
  utcOffsetSeconds: number,
  retry = true,
): Promise<{ pts: PricePoint[]; apiCalls: number; log: string; failed: boolean }> {
  const query = fxsocketMarketQueryRange(fromMs, toMs, utcOffsetSeconds)
  const rangeLabel = `${query.from}→${query.to}`
  try {
    const bars = await fx.priceHistory(ctx.fxsocketAccountId, {
      symbol: brokerSymbol,
      timeframe,
      from: query.from,
      to: query.to,
    })
    const pts = fxsocketBarsToMidPoints(bars, utcOffsetSeconds)
    return {
      pts,
      apiCalls: 1,
      log: `${pts.length} bars (${brokerSymbol}, ${timeframe}, ${rangeLabel})`,
      failed: false,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (retry && isRetriableMarketDataError(msg)) {
      await new Promise((r) => setTimeout(r, 2_000))
      return fetchBarsForSymbol(
        fx, ctx, brokerSymbol, timeframe, fromMs, toMs, utcOffsetSeconds, false,
      )
    }
    const short = sanitizeMarketDataErrorMessage(msg)
    return {
      pts: [],
      apiCalls: 1,
      log: `fetch failed: ${short}`,
      failed: true,
    }
  }
}

export async function fetchTicksForSymbol(
  fx: FxsocketClient,
  ctx: BacktestBrokerContext,
  brokerSymbol: string,
  fromMs: number,
  toMs: number,
  utcOffsetSeconds: number,
  retry = true,
): Promise<{ pts: PricePoint[]; apiCalls: number; log: string; failed: boolean }> {
  const query = fxsocketMarketQueryRange(fromMs, toMs, utcOffsetSeconds)
  const rangeLabel = `${query.from}→${query.to}`
  try {
    const ticks = await fx.quoteTicks(ctx.fxsocketAccountId, {
      symbol: brokerSymbol,
      from: query.from,
      to: query.to,
    })
    const pts = fxsocketTicksToMidPoints(ticks, utcOffsetSeconds)
    return {
      pts,
      apiCalls: 1,
      log: `${pts.length} ticks (${brokerSymbol}, ${rangeLabel})`,
      failed: false,
    }
  } catch (e) {
    if (e instanceof FxsocketApiError && e.status === 404) {
      return {
        pts: [],
        apiCalls: 0,
        log: "QuoteTicks endpoint unavailable — using OHLC bars",
        failed: false,
      }
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (retry && isRetriableMarketDataError(msg)) {
      await new Promise((r) => setTimeout(r, 2_000))
      return fetchTicksForSymbol(
        fx, ctx, brokerSymbol, fromMs, toMs, utcOffsetSeconds, false,
      )
    }
    return {
      pts: [],
      apiCalls: 1,
      log: `ticks fetch failed: ${sanitizeMarketDataErrorMessage(msg)}`,
      failed: true,
    }
  }
}

const SYMBOL_FETCH_CONCURRENCY = 3

async function fetchSymbolSeries(
  fx: FxsocketClient,
  ctx: BacktestBrokerContext,
  symbol: string,
  signals: ParsedSignalForBacktest[],
  config: BacktestRunConfig,
  configFromMs: number,
  configToMs: number,
  utcOffsetSeconds: number,
): Promise<{ symbol: string; pts: PricePoint[]; apiCalls: number; logs: string[]; failed: boolean }> {
  const brokerSymbol = resolveBrokerSymbol(symbol, ctx.brokerSymbols)
  if (!brokerSymbol) {
    return {
      symbol,
      pts: [],
      apiCalls: 0,
      logs: [`${symbol}: not listed on broker ${ctx.brokerLabel}`],
      failed: true,
    }
  }

  const { fromMs, toMs } = signalWindowForSymbol(symbol, signals, configFromMs, configToMs)
  if (fromMs >= toMs) {
    return {
      symbol,
      pts: [],
      apiCalls: 0,
      logs: [`${symbol}: invalid time window`],
      failed: true,
    }
  }

  const timeframe = toFxsocketTimeframe(config.timeframe)
  const logs: string[] = []
  let apiCalls = 0
  let pts: PricePoint[] = []
  let failed = false

  if (config.executionMode === "tick_quotes") {
    const tickResult = await fetchTicksForSymbol(
      fx, ctx, brokerSymbol, fromMs, toMs, utcOffsetSeconds,
    )
    apiCalls += tickResult.apiCalls
    logs.push(`${symbol}: ${tickResult.log}`)
    pts = tickResult.pts
    if (tickResult.failed) failed = true

    if (pts.length === 0 && !tickResult.log.includes("unavailable")) {
      const barResult = await fetchBarsForSymbol(
        fx, ctx, brokerSymbol, timeframe, fromMs, toMs, utcOffsetSeconds,
      )
      apiCalls += barResult.apiCalls
      pts = barResult.pts
      if (barResult.failed) failed = true
      logs.push(`${symbol}: ${barResult.log}`)
    } else if (pts.length === 0 && tickResult.log.includes("unavailable")) {
      const barResult = await fetchBarsForSymbol(
        fx, ctx, brokerSymbol, timeframe, fromMs, toMs, utcOffsetSeconds,
      )
      apiCalls += barResult.apiCalls
      pts = barResult.pts
      if (barResult.failed) failed = true
      logs.push(`${symbol}: ${barResult.log}`)
    }
  } else {
    const barResult = await fetchBarsForSymbol(
      fx, ctx, brokerSymbol, timeframe, fromMs, toMs, utcOffsetSeconds,
    )
    apiCalls += barResult.apiCalls
    pts = barResult.pts
    if (barResult.failed) failed = true
    logs.push(`${symbol}: ${barResult.log}`)
  }

  return { symbol, pts, apiCalls, logs, failed }
}

/**
 * Fetch OHLC bars (or quote ticks) from the user's linked FxSocket broker
 * for every symbol before simulation. Per-symbol failures do not abort the run.
 */
export async function preloadMarketData(
  fx: FxsocketClient,
  ctx: BacktestBrokerContext,
  symbols: string[],
  signals: ParsedSignalForBacktest[],
  config: BacktestRunConfig,
  configFromMs: number,
  configToMs: number,
): Promise<PreloadedMarketData> {
  const utcOffsetSeconds = await fetchUtcOffsetSeconds(fx, ctx.fxsocketAccountId)
  const seriesBySymbol = new Map<string, PricePoint[]>()
  const fetchLog: string[] = []
  let apiCalls = 0
  let fetchFailures = 0

  for (let i = 0; i < symbols.length; i += SYMBOL_FETCH_CONCURRENCY) {
    const batch = symbols.slice(i, i + SYMBOL_FETCH_CONCURRENCY)
    const results = await Promise.all(
      batch.map((symbol) =>
        fetchSymbolSeries(
          fx, ctx, symbol, signals, config, configFromMs, configToMs, utcOffsetSeconds,
        ),
      ),
    )
    for (const r of results) {
      seriesBySymbol.set(r.symbol, r.pts)
      apiCalls += r.apiCalls
      fetchLog.push(...r.logs)
      if (r.failed) fetchFailures++
    }
  }

  return { seriesBySymbol, apiCalls, fetchLog, fetchFailures, brokerContext: ctx, utcOffsetSeconds }
}
