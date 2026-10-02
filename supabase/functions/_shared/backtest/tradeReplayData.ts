import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import type {
  HistoricalMarketDataSource,
  HistoricalMarketDataSources,
} from "./historicalMarketData.ts"
import {
  aggregateMidPointsToOhlc,
  pickCandleIntervalMs,
  resolveBrokerSymbol,
  trimCandlesToTradeWindow,
  type ReplayOhlcCandle,
} from "./fxsocketMarketData.ts"
import { fetchTicksForSymbol } from "./marketData.ts"
import type { PricePoint } from "./simulator.ts"
import { resolveBacktestBroker, type BacktestBrokerContext } from "./resolveBacktestBroker.ts"
import { parseTpLevels } from "./tradeRows.ts"
import type { BacktestTimeframe } from "./types.ts"

const FETCH_PAD_MS = 5 * 60_000
const MAX_OPEN_MS = 5 * 86_400_000
const MAX_TICKS_BEFORE_WIDEN = 20_000
const REPLAY_QUERY_PAD_MS = 2 * 86_400_000
const BAR_TIMEFRAMES: readonly BacktestTimeframe[] = ["1m", "5m", "15m"]
const SHORT_TRADE_MS = 3 * 60_000

export interface TradeReplayTpEvent {
  index: number
  price: number
  ts: number
}

export interface TradeReplayResponse {
  ok: true
  source: "ticks" | "bars"
  intervalMs: number
  candles: ReplayOhlcCandle[]
  markers: {
    entry: { time: number; price: number }
    sl: number | null
    tps: number[]
    tpEvents: TradeReplayTpEvent[]
    exit: { time: number; price: number } | null
  }
  brokerLabel: string
  tradeDurationMs: number
}

export class TradeReplayNotFoundError extends Error {
  constructor() {
    super("Trade not found")
    this.name = "TradeReplayNotFoundError"
  }
}

export class TradeReplayNoDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TradeReplayNoDataError"
  }
}

export function selectPointsForTradeWindow(
  pts: PricePoint[],
  signalMs: number,
  endMs: number,
): PricePoint[] {
  return pts.filter((point) => point.ts >= signalMs && point.ts <= endMs)
}

function parseTpEvents(raw: unknown): TradeReplayTpEvent[] {
  if (!Array.isArray(raw)) return []
  return raw.map((event) => {
    if (!event || typeof event !== "object") return null
    const row = event as Record<string, unknown>
    const index = Number(row.index)
    const price = Number(row.price)
    const ts = Number(row.ts)
    return Number.isFinite(index) && Number.isFinite(price) && Number.isFinite(ts)
      ? { index, price, ts }
      : null
  }).filter((event): event is TradeReplayTpEvent => event != null)
}

function barIntervalMs(timeframe: BacktestTimeframe): number {
  switch (timeframe) {
    case "1m": return 60_000
    case "5m": return 5 * 60_000
    case "15m": return 15 * 60_000
    case "1h": return 60 * 60_000
    case "1d": return 24 * 60 * 60_000
  }
}

function pickBarTimeframe(tradeDurationMs: number): readonly BacktestTimeframe[] {
  if (tradeDurationMs <= SHORT_TRADE_MS) return ["1m"]
  if (tradeDurationMs <= 30 * 60_000) return ["1m", "5m"]
  return BAR_TIMEFRAMES
}

async function fetchBarReplayCandles(
  source: HistoricalMarketDataSource,
  ctx: BacktestBrokerContext,
  brokerSymbol: string,
  fetchFromMs: number,
  fetchToMs: number,
  tradeDurationMs: number,
): Promise<{ candles: ReplayOhlcCandle[]; intervalMs: number } | null> {
  for (const timeframe of pickBarTimeframe(tradeDurationMs)) {
    try {
      const result = await source.historicalBars({
        sessionId: ctx.sessionId,
        platform: ctx.platform,
        symbol: brokerSymbol,
        timeframe,
        fromMs: fetchFromMs - REPLAY_QUERY_PAD_MS,
        toMs: fetchToMs + REPLAY_QUERY_PAD_MS,
      })
      const candles = result.data
        .filter((bar) => bar.ts >= fetchFromMs && bar.ts <= fetchToMs)
        .map((bar): ReplayOhlcCandle => ({
          time: Math.floor(bar.ts / 1000),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        }))
      if (candles.length > 0) return { candles, intervalMs: barIntervalMs(timeframe) }
    } catch {
      // Try the next normalized timeframe before reporting no replay data.
    }
  }
  return null
}

export async function fetchTradeReplayData(
  supabase: SupabaseClient,
  sources: HistoricalMarketDataSources,
  userId: string,
  tradeId: string,
): Promise<TradeReplayResponse> {
  const { data: trade, error: tradeErr } = await supabase
    .from("backtest_trades").select("*").eq("id", tradeId).maybeSingle()
  if (tradeErr) throw new Error(tradeErr.message)
  if (!trade) throw new TradeReplayNotFoundError()

  const { data: run, error: runErr } = await supabase
    .from("backtest_runs").select("user_id, config").eq("id", trade.run_id).maybeSingle()
  if (runErr) throw new Error(runErr.message)
  if (!run || run.user_id !== userId) throw new TradeReplayNotFoundError()

  const signalMs = new Date(String(trade.signal_at)).getTime()
  if (!Number.isFinite(signalMs)) throw new TradeReplayNoDataError("Invalid signal timestamp on this trade.")
  const closedMs = trade.closed_at != null ? new Date(String(trade.closed_at)).getTime() : null
  const endMs = closedMs != null && Number.isFinite(closedMs) ? closedMs : signalMs + MAX_OPEN_MS
  const tradeDurationMs = Math.max(1, endMs - signalMs)
  const fetchFromMs = signalMs - FETCH_PAD_MS
  const fetchToMs = endMs + FETCH_PAD_MS

  const symbol = String(trade.symbol)
  const brokerCtx = await resolveBacktestBroker(supabase, sources, userId, symbol)
  const sourceClient = sources[brokerCtx.provider]
  if (!sourceClient) throw new TradeReplayNoDataError("The active broker market-data provider is unavailable.")
  const brokerSymbol = resolveBrokerSymbol(symbol, brokerCtx.brokerSymbols)
  if (!brokerSymbol) throw new TradeReplayNoDataError(`Symbol ${symbol} is not available on your linked broker.`)

  let source: "ticks" | "bars" = "ticks"
  let intervalMs = pickCandleIntervalMs(tradeDurationMs, 0)
  let candles: ReplayOhlcCandle[] = []
  const tickResult = await fetchTicksForSymbol(
    sourceClient, brokerCtx, brokerSymbol, fetchFromMs, fetchToMs,
  )
  const ticksForReplay = selectPointsForTradeWindow(tickResult.pts, signalMs, endMs)
  const tickUnavailable = !sourceClient.historicalTicks || tickResult.log.includes("unavailable")

  if (ticksForReplay.length > 0) {
    let effectiveInterval = pickCandleIntervalMs(tradeDurationMs, ticksForReplay.length)
    if (ticksForReplay.length > MAX_TICKS_BEFORE_WIDEN) {
      effectiveInterval = Math.max(effectiveInterval, Math.ceil(tradeDurationMs / 500))
    }
    intervalMs = effectiveInterval
    candles = aggregateMidPointsToOhlc(ticksForReplay, intervalMs)
  }

  if (candles.length === 0) {
    source = "bars"
    const replay = await fetchBarReplayCandles(
      sourceClient, brokerCtx, brokerSymbol, fetchFromMs, fetchToMs, tradeDurationMs,
    )
    if (replay) {
      candles = replay.candles
      intervalMs = replay.intervalMs
    }
  }

  candles = trimCandlesToTradeWindow(candles, signalMs, endMs, intervalMs)
  if (candles.length === 0) {
    throw new TradeReplayNoDataError(tickUnavailable
      ? "Quote ticks unavailable and OHLC bars could not be loaded for this trade window."
      : "No market data found for this trade window.")
  }

  const details = (trade.details ?? {}) as Record<string, unknown>
  const entryPrice = Number(trade.entry_price)
  const exitPrice = trade.exit_price != null ? Number(trade.exit_price) : null
  const exitTimeSec = closedMs != null && Number.isFinite(closedMs) ? Math.floor(closedMs / 1000) : null
  return {
    ok: true,
    source,
    intervalMs,
    candles,
    markers: {
      entry: { time: Math.floor(signalMs / 1000), price: entryPrice },
      sl: trade.sl != null ? Number(trade.sl) : null,
      tps: parseTpLevels(trade.tp_levels),
      tpEvents: parseTpEvents(details.tpEvents),
      exit: exitTimeSec != null && exitPrice != null && Number.isFinite(exitPrice)
        ? { time: exitTimeSec, price: exitPrice }
        : null,
    },
    brokerLabel: brokerCtx.brokerLabel,
    tradeDurationMs,
  }
}
