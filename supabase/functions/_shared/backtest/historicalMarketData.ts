import type { BacktestTimeframe } from "./types.ts"
import { barsToMidPoints, type PricePoint } from "./simulator.ts"

export type BacktestBrokerProvider = "fxsocket" | "mtapi"

export interface HistoricalBar {
  /** UTC epoch milliseconds after provider-specific clock normalization. */
  ts: number
  open: number
  high: number
  low: number
  close: number
  spread?: number
}

export interface HistoricalFetchResult<T> {
  data: T[]
  requestCount: number
}

export interface HistoricalBarsRequest {
  sessionId: string
  platform: string | null
  symbol: string
  timeframe: BacktestTimeframe
  fromMs: number
  toMs: number
}

export interface HistoricalTicksRequest {
  sessionId: string
  platform: string | null
  symbol: string
  fromMs: number
  toMs: number
}

/** Small provider-neutral surface required by backtest, resimulation, and replay. */
export interface HistoricalMarketDataSource {
  readonly provider: BacktestBrokerProvider
  symbols(sessionId: string, platform: string | null): Promise<string[]>
  historicalBars(
    request: HistoricalBarsRequest,
  ): Promise<HistoricalFetchResult<HistoricalBar>>
  /** Temporary FXSocket-only capability. MTAPI deliberately omits it in Phase 4F. */
  historicalTicks?(
    request: HistoricalTicksRequest,
  ): Promise<HistoricalFetchResult<PricePoint>>
}

export type HistoricalMarketDataSources = Partial<
  Record<BacktestBrokerProvider, HistoricalMarketDataSource>
>

/** Preserve the simulator's intentional conservative OHLC envelope unchanged. */
export function historicalBarsToPricePoints(
  bars: HistoricalBar[],
): PricePoint[] {
  return barsToMidPoints(bars.map((bar) => ({
    t: bar.ts,
    o: bar.open,
    h: bar.high,
    l: bar.low,
    c: bar.close,
  })))
}

export function mergeHistoricalBars(
  chunks: Iterable<HistoricalBar[]>,
  fromMs: number,
  toMs: number,
): HistoricalBar[] {
  const byTimestamp = new Map<number, HistoricalBar>()
  for (const chunk of chunks) {
    for (const bar of chunk) {
      if (bar.ts < fromMs || bar.ts > toMs) continue
      byTimestamp.set(bar.ts, bar)
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.ts - b.ts)
}
