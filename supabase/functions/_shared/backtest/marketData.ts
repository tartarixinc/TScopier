import {
  historicalBarsToPricePoints,
  type HistoricalMarketDataSource,
  type HistoricalMarketDataSources,
} from "./historicalMarketData.ts"
import {
  isRetriableMarketDataError,
  resolveBrokerSymbol,
  sanitizeMarketDataErrorMessage,
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
}

function signalWindowForSymbol(
  symbol: string,
  signals: ParsedSignalForBacktest[],
  configFromMs: number,
  configToMs: number,
): { fromMs: number; toMs: number } {
  const symSigs = signals.filter((s) => s.symbol === symbol)
  if (!symSigs.length) return { fromMs: configFromMs, toMs: configToMs }
  const minSig = Math.min(...symSigs.map((s) => s.signalAt.getTime()))
  const maxSig = Math.max(...symSigs.map((s) => s.signalAt.getTime()))
  return {
    fromMs: Math.max(configFromMs, minSig - 24 * 3_600_000),
    toMs: Math.min(configToMs, maxSig + 5 * 24 * 3_600_000),
  }
}

export async function fetchBarsForSymbol(
  source: HistoricalMarketDataSource,
  ctx: BacktestBrokerContext,
  brokerSymbol: string,
  timeframe: BacktestRunConfig["timeframe"],
  fromMs: number,
  toMs: number,
  retry = true,
): Promise<{ pts: PricePoint[]; apiCalls: number; log: string; failed: boolean }> {
  try {
    const result = await source.historicalBars({
      sessionId: ctx.sessionId,
      platform: ctx.platform,
      symbol: brokerSymbol,
      timeframe,
      fromMs,
      toMs,
    })
    const pts = historicalBarsToPricePoints(result.data)
    return {
      pts,
      apiCalls: result.requestCount,
      log: `${pts.length} bars (${brokerSymbol}, ${timeframe}, ${new Date(fromMs).toISOString()}→${new Date(toMs).toISOString()})`,
      failed: false,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (String((error as { code?: unknown })?.code ?? "") === "MTAPI_HISTORY_TIMEZONE_UNVERIFIED") {
      throw error
    }
    if (retry && isRetriableMarketDataError(message)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      return await fetchBarsForSymbol(source, ctx, brokerSymbol, timeframe, fromMs, toMs, false)
    }
    return {
      pts: [],
      apiCalls: 1,
      log: `fetch failed: ${sanitizeMarketDataErrorMessage(message)}`,
      failed: true,
    }
  }
}

export async function fetchTicksForSymbol(
  source: HistoricalMarketDataSource,
  ctx: BacktestBrokerContext,
  brokerSymbol: string,
  fromMs: number,
  toMs: number,
  retry = true,
): Promise<{ pts: PricePoint[]; apiCalls: number; log: string; failed: boolean }> {
  if (!source.historicalTicks) {
    return {
      pts: [],
      apiCalls: 0,
      log: "MTAPI tick history unavailable/unverified — using OHLC bars",
      failed: false,
    }
  }
  try {
    const result = await source.historicalTicks({
      sessionId: ctx.sessionId,
      platform: ctx.platform,
      symbol: brokerSymbol,
      fromMs,
      toMs,
    })
    return {
      pts: result.data,
      apiCalls: result.requestCount,
      log: `${result.data.length} ticks (${brokerSymbol}, ${new Date(fromMs).toISOString()}→${new Date(toMs).toISOString()})`,
      failed: false,
    }
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status)
    if (status === 404) {
      return { pts: [], apiCalls: 0, log: "QuoteTicks endpoint unavailable — using OHLC bars", failed: false }
    }
    const message = error instanceof Error ? error.message : String(error)
    if (retry && isRetriableMarketDataError(message)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      return await fetchTicksForSymbol(source, ctx, brokerSymbol, fromMs, toMs, false)
    }
    return {
      pts: [],
      apiCalls: 1,
      log: `ticks fetch failed: ${sanitizeMarketDataErrorMessage(message)}`,
      failed: true,
    }
  }
}

const SYMBOL_FETCH_CONCURRENCY = 3

async function fetchSymbolSeries(
  source: HistoricalMarketDataSource,
  ctx: BacktestBrokerContext,
  symbol: string,
  signals: ParsedSignalForBacktest[],
  config: BacktestRunConfig,
  configFromMs: number,
  configToMs: number,
): Promise<{ symbol: string; pts: PricePoint[]; apiCalls: number; logs: string[]; failed: boolean }> {
  const brokerSymbol = resolveBrokerSymbol(symbol, ctx.brokerSymbols)
  if (!brokerSymbol) {
    return { symbol, pts: [], apiCalls: 0, logs: [`${symbol}: not listed on broker ${ctx.brokerLabel}`], failed: true }
  }
  const { fromMs, toMs } = signalWindowForSymbol(symbol, signals, configFromMs, configToMs)
  if (fromMs >= toMs) {
    return { symbol, pts: [], apiCalls: 0, logs: [`${symbol}: invalid time window`], failed: true }
  }

  const logs: string[] = []
  let apiCalls = 0
  let pts: PricePoint[] = []
  let failed = false
  if (config.executionMode === "tick_quotes") {
    const ticks = await fetchTicksForSymbol(source, ctx, brokerSymbol, fromMs, toMs)
    apiCalls += ticks.apiCalls
    logs.push(`${symbol}: ${ticks.log}`)
    pts = ticks.pts
    failed = ticks.failed
  }
  if (pts.length === 0) {
    const bars = await fetchBarsForSymbol(source, ctx, brokerSymbol, config.timeframe, fromMs, toMs)
    apiCalls += bars.apiCalls
    logs.push(`${symbol}: ${bars.log}`)
    pts = bars.pts
    failed = bars.failed
  }
  return { symbol, pts, apiCalls, logs, failed }
}

/** Fetch normalized history from the broker account's authoritative provider. */
export async function preloadMarketData(
  sources: HistoricalMarketDataSources,
  ctx: BacktestBrokerContext,
  symbols: string[],
  signals: ParsedSignalForBacktest[],
  config: BacktestRunConfig,
  configFromMs: number,
  configToMs: number,
): Promise<PreloadedMarketData> {
  const source = sources[ctx.provider]
  if (!source) throw new Error(`${ctx.provider} market data source is unavailable`)
  const seriesBySymbol = new Map<string, PricePoint[]>()
  const fetchLog: string[] = []
  let apiCalls = 0
  let fetchFailures = 0

  for (let i = 0; i < symbols.length; i += SYMBOL_FETCH_CONCURRENCY) {
    const results = await Promise.all(symbols.slice(i, i + SYMBOL_FETCH_CONCURRENCY).map((symbol) =>
      fetchSymbolSeries(source, ctx, symbol, signals, config, configFromMs, configToMs)
    ))
    for (const result of results) {
      seriesBySymbol.set(result.symbol, result.pts)
      apiCalls += result.apiCalls
      fetchLog.push(...result.logs)
      if (result.failed) fetchFailures += 1
    }
  }
  return { seriesBySymbol, apiCalls, fetchLog, fetchFailures, brokerContext: ctx }
}
