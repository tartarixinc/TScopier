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

/**
 * Canonical instrument id so broker Market Watch names like GOLD / XAU match signal XAUUSD.
 * Keys and values are already normalizeBacktestSymbol'd.
 */
const BACKTEST_SYMBOL_CANONICAL: Record<string, string> = {
  GOLD: "XAUUSD",
  XAU: "XAUUSD",
  SILVER: "XAGUSD",
  XAG: "XAGUSD",
  BITCOIN: "BTCUSD",
  BTC: "BTCUSD",
  ETHEREUM: "ETHUSD",
  ETH: "ETHUSD",
}

/** Map GOLD ↔ XAUUSD (and similar) for broker symbol matching. */
export function canonicalBacktestSymbol(raw: string): string {
  const n = normalizeBacktestSymbol(raw)
  return BACKTEST_SYMBOL_CANONICAL[n] ?? n
}

/**
 * After a base/target prefix matches, only an allowed quote-currency fragment
 * (USD/USDT/USDC) plus known broker suffix tokens may follow. Anything else —
 * e.g. "AUD" in `BTCAUDm` — is a different instrument and must never be
 * resolved for a USD-quoted signal (2026-11-01: BTCAUDm was picked for BTCUSD
 * on an Exness suffix server and the whole backtest simulated BTC in AUD).
 */
const ALLOWED_QUOTE_FRAGMENTS = ["USDT", "USDC", "USD"]
// Superset of worker/src/tradeExecutor/brokerSymbolCache.ts BROKER_SYMBOL_SUFFIXES
// (M/RAW/PRO/R/I/C/S/X/A/CASH) plus common broker decorations. Single letters
// keep old accept-anything behavior for decorated names without reopening the
// cross-currency hole (AUD/CNH/EUR never start with an allowed fragment).
const BROKER_SUFFIX_TOKENS = [
  "CASH", "MINI", "MICRO", "ECN", "RAW", "STD", "PRO", "STP", "CENT",
  "247", "SD", "TM", "M", "R", "T", "X", "E", "F", "I", "P", "S", "C", "A",
]

function brokerSymbolRemainderAllowed(remainder: string): boolean {
  let rest = remainder
  while (rest.length > 0) {
    const quote = ALLOWED_QUOTE_FRAGMENTS.find((q) => rest.startsWith(q))
    if (quote) {
      rest = rest.slice(quote.length)
      continue
    }
    const suffix = BROKER_SUFFIX_TOKENS.find((s) => rest.startsWith(s))
    if (suffix) {
      rest = rest.slice(suffix.length)
      continue
    }
    return false
  }
  return true
}

/** Shortest-first prefix match on the given targets, keeping only quote-safe extensions. */
function matchBrokerSymbolPrefix(
  prefixTargets: string[],
  brokerSymbols: string[],
): string | null {
  const prefixes = [...new Set(prefixTargets.filter(Boolean))]
  if (prefixes.length === 0) return null
  const matches = brokerSymbols
    .filter((sym) => {
      const norm = normalizeBacktestSymbol(sym)
      return prefixes.some((t) => {
        if (!norm.startsWith(t)) return false
        return brokerSymbolRemainderAllowed(norm.slice(t.length))
      })
    })
    .sort((a, b) => a.length - b.length)
  return matches[0] ?? null
}

/** Match a normalized symbol to an exact broker Market Watch name (handles suffixes + GOLD/XAU aliases). */
export function resolveBrokerSymbol(normalized: string, brokerSymbols: string[]): string | null {
  const target = normalizeBacktestSymbol(normalized)
  if (!target) return null

  const canon = canonicalBacktestSymbol(target)
  const targets = new Set<string>([target, canon])
  for (const [alias, canonical] of Object.entries(BACKTEST_SYMBOL_CANONICAL)) {
    if (canonical === canon) targets.add(alias)
  }

  // Exact match on any target/alias — always safe (aliases never extend prefix matching).
  for (const sym of brokerSymbols) {
    if (targets.has(normalizeBacktestSymbol(sym))) return sym
  }

  // Prefix match on the canonical id (BTCUSD → BTCUSDm / BTCUSDTm, never BTCAUDm).
  const canonMatch = matchBrokerSymbolPrefix([canon], brokerSymbols)
  if (canonMatch) return canonMatch

  // Prefix match on the raw target and its aliases (GOLD → GOLD.m, XAU →
  // XAU.r). The quote-safe grammar still applies, so the BTC alias can never
  // reach BTCAUDm / BTCCNHm — only USD-style extensions and broker suffixes.
  const targetMatch = matchBrokerSymbolPrefix([...targets], brokerSymbols)
  if (targetMatch) return targetMatch

  // Broker lists GOLD while signal is XAUUSD — match on canonical equality.
  for (const sym of brokerSymbols) {
    if (canonicalBacktestSymbol(sym) === canon) return sym
  }

  // Broker lists a shorter root than the signal (BTC listed for a BTCUSD
  // signal). Restricted to the canonical/target pair and the longest root
  // wins, so raw aliases cannot reintroduce the BTCAUDm bug and a stray
  // two-letter fragment ("BT") never beats a real root.
  let shorterRoot: string | null = null
  for (const sym of brokerSymbols) {
    const norm = normalizeBacktestSymbol(sym)
    for (const t of [target, canon]) {
      if (t.length > norm.length && t.startsWith(norm)) {
        if (!shorterRoot || norm.length > normalizeBacktestSymbol(shorterRoot).length) {
          shorterRoot = sym
        }
      }
    }
  }
  if (shorterRoot) return shorterRoot

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
