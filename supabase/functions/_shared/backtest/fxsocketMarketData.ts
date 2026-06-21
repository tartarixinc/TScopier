import type { FxsocketPriceBar, FxsocketQuoteTick } from "../fxsocketClient.ts"
import type { PricePoint } from "./simulator.ts"
import type { BacktestTimeframe } from "./types.ts"

export interface ReplayOhlcCandle {
  /** UTC epoch seconds (lightweight-charts time scale). */
  time: number
  open: number
  high: number
  low: number
  close: number
}

const MS_5S = 5_000
const MS_30S = 30_000
const MS_1M = 60_000
const MS_5M = 5 * 60_000
const MS_15M = 15 * 60_000
const MAX_REPLAY_CANDLES = 500

/** Pick candle bucket size from trade duration and tick volume. */
export function pickCandleIntervalMs(durationMs: number, tickCount: number): number {
  let interval: number
  if (durationMs < 30 * MS_1M) interval = MS_5S
  else if (durationMs < 4 * 60 * MS_1M) interval = MS_30S
  else if (durationMs < 24 * 60 * MS_1M) interval = MS_5M
  else interval = MS_15M

  if (tickCount > 0 && durationMs > 0) {
    const minForTicks = Math.ceil(durationMs / MAX_REPLAY_CANDLES)
    if (minForTicks > interval) interval = minForTicks
  }
  return interval
}

/** Aggregate bid/ask mid ticks into OHLC candles. */
export function aggregateMidPointsToOhlc(
  points: PricePoint[],
  intervalMs: number,
): ReplayOhlcCandle[] {
  if (!points.length || intervalMs <= 0) return []

  const buckets = new Map<number, PricePoint[]>()
  for (const p of points) {
    const key = Math.floor(p.ts / intervalMs) * intervalMs
    const arr = buckets.get(key)
    if (arr) arr.push(p)
    else buckets.set(key, [p])
  }

  const candles: ReplayOhlcCandle[] = []
  for (const [bucketMs, pts] of buckets) {
    pts.sort((a, b) => a.ts - b.ts)
    const first = pts[0]!
    const last = pts[pts.length - 1]!
    let high = -Infinity
    let low = Infinity
    for (const p of pts) {
      high = Math.max(high, p.ask, p.mid)
      low = Math.min(low, p.bid, p.mid)
    }
    candles.push({
      time: Math.floor(bucketMs / 1000),
      open: first.mid,
      high,
      low,
      close: last.mid,
    })
  }

  return candles.sort((a, b) => a.time - b.time)
}

/** Map FxSocket OHLC bars directly to replay candles (M1 fallback). */
export function fxsocketBarsToOhlcCandles(
  bars: FxsocketPriceBar[],
  utcOffsetSeconds = 0,
  fromMs?: number,
  toMs?: number,
): ReplayOhlcCandle[] {
  const offsetMs = utcOffsetSeconds * 1000
  return bars
    .map((b) => {
      const ts = Date.parse(b.time)
      if (!Number.isFinite(ts)) return null
      const t = ts - offsetMs
      if (fromMs != null && t < fromMs) return null
      if (toMs != null && t > toMs) return null
      return {
        time: Math.floor(t / 1000),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }
    })
    .filter((c): c is ReplayOhlcCandle => c != null)
    .sort((a, b) => a.time - b.time)
}

/** Keep candles from entry bar through exit bar (no pre-entry padding). */
export function trimCandlesToTradeWindow(
  candles: ReplayOhlcCandle[],
  signalMs: number,
  endMs: number,
  intervalMs: number,
): ReplayOhlcCandle[] {
  if (!candles.length) return candles
  const bucketSec = Math.max(1, Math.floor(intervalMs / 1000))
  const signalSec = Math.floor(signalMs / 1000)
  const endSec = Math.ceil(endMs / 1000)
  const entryBarSec = signalSec - (signalSec % bucketSec)
  const exitBarSec = Math.floor(endSec / bucketSec) * bucketSec + bucketSec

  return candles
    .filter((c) => c.time >= entryBarSec && c.time <= exitBarSec)
    .sort((a, b) => a.time - b.time)
}

/** Map backtest timeframe to FXsocket MT5 labels (M1, M5, H1, D1, …). */
export function toFxsocketTimeframe(tf: BacktestTimeframe): string {
  switch (tf) {
    case "1m": return "M1"
    case "5m": return "M5"
    case "15m": return "M15"
    case "1h": return "H1"
    case "1d": return "D1"
    default: return "M5"
  }
}

/** Normalize signal symbol for broker symbol matching (EURUSD, XAUUSD). */
export function normalizeBacktestSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** Match a normalized symbol to an exact broker Market Watch name (handles suffixes). */
export function resolveBrokerSymbol(normalized: string, brokerSymbols: string[]): string | null {
  const target = normalizeBacktestSymbol(normalized)
  if (!target) return null

  for (const sym of brokerSymbols) {
    if (normalizeBacktestSymbol(sym) === target) return sym
  }

  // Prefer shortest exact-prefix match (XAUUSD before XAUUSD.pro)
  const prefixMatches = brokerSymbols
    .filter((sym) => normalizeBacktestSymbol(sym).startsWith(target))
    .sort((a, b) => a.length - b.length)
  if (prefixMatches.length > 0) return prefixMatches[0]!

  for (const sym of brokerSymbols) {
    const norm = normalizeBacktestSymbol(sym)
    if (target.startsWith(norm) || norm.startsWith(target)) return sym
  }

  return null
}

function tickTimestampMs(tick: FxsocketQuoteTick): number {
  if (tick.timeMsc != null && Number.isFinite(tick.timeMsc)) return tick.timeMsc
  const parsed = Date.parse(tick.time)
  return Number.isFinite(parsed) ? parsed : 0
}

/** OHLC bar → bid/ask envelope for conservative intrabar SL/TP checks. */
export function fxsocketBarsToMidPoints(
  bars: FxsocketPriceBar[],
  utcOffsetSeconds = 0,
): PricePoint[] {
  const offsetMs = utcOffsetSeconds * 1000
  return bars
    .map((b) => {
      const ts = Date.parse(b.time)
      if (!Number.isFinite(ts)) return null
      return {
        ts: ts - offsetMs,
        bid: b.low,
        ask: b.high,
        mid: b.close,
      }
    })
    .filter((p): p is PricePoint => p != null)
    .sort((a, b) => a.ts - b.ts)
}

export function fxsocketTicksToMidPoints(
  ticks: FxsocketQuoteTick[],
  utcOffsetSeconds = 0,
): PricePoint[] {
  const offsetMs = utcOffsetSeconds * 1000
  return ticks
    .filter((t) => Number.isFinite(t.bid) && Number.isFinite(t.ask))
    .map((t) => ({
      ts: tickTimestampMs(t) - offsetMs,
      bid: t.bid,
      ask: t.ask,
      mid: (t.bid + t.ask) / 2,
    }))
    .filter((p) => p.ts > 0)
    .sort((a, b) => a.ts - b.ts)
}

/** Format ms as YYYY-MM-DD for FXsocket from/to query params (UTC — prefer server time helper). */
export function msToFxsocketDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const DAY_MS = 86_400_000

/** Format UTC epoch ms as YYYY-MM-DD in broker server time (FxSocket from/to params). */
export function msToFxsocketServerDate(ms: number, utcOffsetSeconds: number): string {
  const serverMs = ms + utcOffsetSeconds * 1000
  return new Date(serverMs).toISOString().slice(0, 10)
}

/** Inclusive FxSocket query window in broker server dates, padded so from < to. */
export function fxsocketMarketQueryRange(
  fromMs: number,
  toMs: number,
  utcOffsetSeconds: number,
  padMs = DAY_MS,
): { from: string; to: string } {
  const qFrom = fromMs - padMs
  const qTo = toMs + padMs
  let from = msToFxsocketServerDate(qFrom, utcOffsetSeconds)
  let to = msToFxsocketServerDate(qTo, utcOffsetSeconds)
  if (from >= to) {
    to = msToFxsocketServerDate(qTo + DAY_MS, utcOffsetSeconds)
  }
  return { from, to }
}

/** User-facing market data error without internal trace noise. */
export function sanitizeMarketDataErrorMessage(raw: string): string {
  const t = String(raw ?? "").trim()
  if (!t) return "Market data request failed"
  if (/MRPC_TIMEOUT|timed out/i.test(t)) {
    return "Broker history request timed out — MT5 may still be downloading data; try again or use a coarser timeframe."
  }
  if (/CopyRates failed|CopyTicks failed/i.test(t)) {
    return "Broker has no history for this symbol or timeframe — check the symbol is listed in Market Watch."
  }
  if (/rate limit/i.test(t)) {
    return "Market data rate limit — try again in a minute."
  }
  return t
}

export function isRetriableMarketDataError(message: string): boolean {
  return /MRPC_TIMEOUT|timed out|CopyRates failed|CopyTicks failed|download/i.test(message)
}
