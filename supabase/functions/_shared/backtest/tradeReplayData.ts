import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import type { FxsocketClient } from "../fxsocketClient.ts"
import {
  aggregateMidPointsToOhlc,
  fxsocketBarsToOhlcCandles,
  fxsocketMarketQueryRange,
  pickCandleIntervalMs,
  resolveBrokerSymbol,
  trimCandlesToTradeWindow,
  type ReplayOhlcCandle,
} from "./fxsocketMarketData.ts"
import {
  fetchTicksForSymbol,
  fetchUtcOffsetSeconds,
} from "./marketData.ts"
import type { PricePoint } from "./simulator.ts"
import { resolveBacktestBroker, type BacktestBrokerContext } from "./resolveBacktestBroker.ts"
import { parseTpLevels } from "./tradeRows.ts"

/** Wide fetch window so FxSocket returns enough history around the trade. */
const FETCH_PAD_MS = 5 * 60_000
const MAX_OPEN_MS = 5 * 86_400_000
const MAX_TICKS_BEFORE_WIDEN = 20_000
const REPLAY_QUERY_PAD_MS = 2 * 86_400_000
const BAR_TIMEFRAMES = ["M1", "M5", "M15"] as const
/** Sub-minute trades need finer candles than M1 when ticks are available. */
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

/** Select ticks strictly within the trade window (no fallback to all fetched data). */
export function selectPointsForTradeWindow(
  pts: PricePoint[],
  signalMs: number,
  endMs: number,
): PricePoint[] {
  return pts.filter((p) => p.ts >= signalMs && p.ts <= endMs)
}

function parseTpEvents(raw: unknown): TradeReplayTpEvent[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((e) => {
      if (!e || typeof e !== "object") return null
      const o = e as Record<string, unknown>
      const index = Number(o.index)
      const price = Number(o.price)
      const ts = Number(o.ts)
      if (!Number.isFinite(index) || !Number.isFinite(price) || !Number.isFinite(ts)) return null
      return { index, price, ts }
    })
    .filter((e): e is TradeReplayTpEvent => e != null)
}

function barIntervalMs(timeframe: string): number {
  switch (timeframe) {
    case "M1": return 60_000
    case "M5": return 5 * 60_000
    case "M15": return 15 * 60_000
    default: return 60_000
  }
}

function pickBarTimeframe(tradeDurationMs: number): readonly string[] {
  if (tradeDurationMs <= SHORT_TRADE_MS) return ["M1"]
  if (tradeDurationMs <= 30 * 60_000) return ["M1", "M5"]
  return BAR_TIMEFRAMES
}

async function fetchBarReplayCandles(
  fx: FxsocketClient,
  ctx: BacktestBrokerContext,
  brokerSymbol: string,
  fetchFromMs: number,
  fetchToMs: number,
  utcOffsetSeconds: number,
  tradeDurationMs: number,
): Promise<{ candles: ReplayOhlcCandle[]; intervalMs: number } | null> {
  for (const tf of pickBarTimeframe(tradeDurationMs)) {
    const query = fxsocketMarketQueryRange(fetchFromMs, fetchToMs, utcOffsetSeconds, REPLAY_QUERY_PAD_MS)
    try {
      const bars = await fx.priceHistory(ctx.fxsocketAccountId, {
        symbol: brokerSymbol,
        timeframe: tf,
        from: query.from,
        to: query.to,
      })
      if (!bars.length) continue

      const ohlc = fxsocketBarsToOhlcCandles(bars, utcOffsetSeconds, fetchFromMs, fetchToMs)
      if (ohlc.length > 0) {
        return { candles: ohlc, intervalMs: barIntervalMs(tf) }
      }
    } catch {
      // try next timeframe
    }
  }
  return null
}

export async function fetchTradeReplayData(
  supabase: SupabaseClient,
  fx: FxsocketClient,
  userId: string,
  tradeId: string,
): Promise<TradeReplayResponse> {
  const { data: trade, error: tradeErr } = await supabase
    .from("backtest_trades")
    .select("*")
    .eq("id", tradeId)
    .maybeSingle()
  if (tradeErr) throw new Error(tradeErr.message)
  if (!trade) throw new TradeReplayNotFoundError()

  const { data: run, error: runErr } = await supabase
    .from("backtest_runs")
    .select("user_id, config")
    .eq("id", trade.run_id)
    .maybeSingle()
  if (runErr) throw new Error(runErr.message)
  if (!run || run.user_id !== userId) throw new TradeReplayNotFoundError()

  const signalMs = new Date(String(trade.signal_at)).getTime()
  if (!Number.isFinite(signalMs)) {
    throw new TradeReplayNoDataError("Invalid signal timestamp on this trade.")
  }

  const closedMs = trade.closed_at != null
    ? new Date(String(trade.closed_at)).getTime()
    : null
  const endMs = (closedMs != null && Number.isFinite(closedMs))
    ? closedMs
    : signalMs + MAX_OPEN_MS
  const tradeDurationMs = Math.max(1, endMs - signalMs)
  const fetchFromMs = signalMs - FETCH_PAD_MS
  const fetchToMs = endMs + FETCH_PAD_MS

  const symbol = String(trade.symbol)
  const brokerCtx = await resolveBacktestBroker(supabase, fx, userId, symbol)
  const brokerSymbol = resolveBrokerSymbol(symbol, brokerCtx.brokerSymbols)
  if (!brokerSymbol) {
    throw new TradeReplayNoDataError(`Symbol ${symbol} is not available on your linked broker.`)
  }

  const utcOffsetSeconds = await fetchUtcOffsetSeconds(fx, brokerCtx.fxsocketAccountId)

  let source: "ticks" | "bars" = "ticks"
  let intervalMs = pickCandleIntervalMs(tradeDurationMs, 0)
  let candles: ReplayOhlcCandle[] = []

  const tickResult = await fetchTicksForSymbol(
    fx,
    brokerCtx,
    brokerSymbol,
    fetchFromMs,
    fetchToMs,
    utcOffsetSeconds,
  )

  const ticksForReplay = selectPointsForTradeWindow(tickResult.pts, signalMs, endMs)
  const tickUnavailable = tickResult.log.includes("unavailable")

  if (ticksForReplay.length > 0) {
    let effectiveInterval = pickCandleIntervalMs(tradeDurationMs, ticksForReplay.length)
    if (ticksForReplay.length > MAX_TICKS_BEFORE_WIDEN) {
      effectiveInterval = Math.max(
        effectiveInterval,
        Math.ceil(tradeDurationMs / 500),
      )
    }
    intervalMs = effectiveInterval
    candles = aggregateMidPointsToOhlc(ticksForReplay, intervalMs)
  }

  if (candles.length === 0) {
    source = "bars"
    const barReplay = await fetchBarReplayCandles(
      fx, brokerCtx, brokerSymbol, fetchFromMs, fetchToMs, utcOffsetSeconds, tradeDurationMs,
    )
    if (barReplay) {
      candles = barReplay.candles
      intervalMs = barReplay.intervalMs
    }
  }

  candles = trimCandlesToTradeWindow(candles, signalMs, endMs, intervalMs)

  if (candles.length === 0) {
    const msg = tickUnavailable
      ? "Quote ticks unavailable and OHLC bars could not be loaded for this trade window."
      : "No market data found for this trade window."
    throw new TradeReplayNoDataError(msg)
  }

  const details = (trade.details ?? {}) as Record<string, unknown>
  const entryPrice = Number(trade.entry_price)
  const exitPrice = trade.exit_price != null ? Number(trade.exit_price) : null
  const exitTimeSec = closedMs != null && Number.isFinite(closedMs)
    ? Math.floor(closedMs / 1000)
    : null

  return {
    ok: true,
    source,
    intervalMs,
    candles,
    markers: {
      entry: {
        time: Math.floor(signalMs / 1000),
        price: entryPrice,
      },
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
