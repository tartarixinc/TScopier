import { assertEquals } from "jsr:@std/assert"
import {
  parsePriceHistoryResponse,
  parseQuoteTicksResponse,
} from "../fxsocketClient.ts"
import {
  fxsocketBarsToMidPoints,
  fxsocketTicksToMidPoints,
  normalizeBacktestSymbol,
  resolveBrokerSymbol,
  toFxsocketTimeframe,
  aggregateMidPointsToOhlc,
  pickCandleIntervalMs,
  msToFxsocketServerDate,
  fxsocketMarketQueryRange,
  trimCandlesToTradeWindow,
} from "./fxsocketMarketData.ts"

Deno.test("toFxsocketTimeframe maps backtest timeframes to MT5 labels", () => {
  assertEquals(toFxsocketTimeframe("1m"), "M1")
  assertEquals(toFxsocketTimeframe("5m"), "M5")
  assertEquals(toFxsocketTimeframe("15m"), "M15")
  assertEquals(toFxsocketTimeframe("1h"), "H1")
  assertEquals(toFxsocketTimeframe("1d"), "D1")
})

Deno.test("resolveBrokerSymbol matches suffix broker names", () => {
  const symbols = ["EURUSD.sd", "GBPUSD.sd", "XAUUSD.r", "US30.cash"]
  assertEquals(resolveBrokerSymbol("EURUSD", symbols), "EURUSD.sd")
  assertEquals(resolveBrokerSymbol("XAUUSD", symbols), "XAUUSD.r")
  assertEquals(resolveBrokerSymbol("US30", symbols), "US30.cash")
  assertEquals(resolveBrokerSymbol("BTCUSD", symbols), null)
})

Deno.test("resolveBrokerSymbol maps GOLD / XAU aliases to XAUUSD", () => {
  assertEquals(resolveBrokerSymbol("XAUUSD", ["GOLD", "EURUSD"]), "GOLD")
  assertEquals(resolveBrokerSymbol("XAUUSD", ["XAU", "EURUSD"]), "XAU")
  assertEquals(resolveBrokerSymbol("GOLD", ["XAUUSD+", "EURUSD"]), "XAUUSD+")
  assertEquals(resolveBrokerSymbol("XAUUSD", ["GOLD.m", "EURUSD"]), "GOLD.m")
})

Deno.test("resolveBrokerSymbol prefers canonical names over aliases regardless of broker list order", () => {
  // 2026-11-02: on a server listing both, GOLD appeared first in the Symbols
  // list and its GOLD symbol has no history while XAUUSD does — gold backtests
  // resolved to a data-less alias. Canonical must win in either order.
  assertEquals(resolveBrokerSymbol("XAUUSD", ["GOLD", "XAUUSD"]), "XAUUSD")
  assertEquals(resolveBrokerSymbol("XAUUSD", ["XAUUSD", "GOLD"]), "XAUUSD")
  assertEquals(resolveBrokerSymbol("XAUUSD", ["GOLD", "XAUUSDm"]), "XAUUSDm")
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BTC", "BTCUSDm"]), "BTCUSDm")
  // Decorated canonical beats a bare alias; bare canonical beats a decorated alias.
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BTCUSDm", "BTC"]), "BTCUSDm")
  // Alias still resolves when no canonical-shaped name exists.
  assertEquals(resolveBrokerSymbol("XAUUSD", ["GOLD", "EURUSD"]), "GOLD")
})

Deno.test("normalizeBacktestSymbol strips punctuation", () => {
  assertEquals(normalizeBacktestSymbol("XAU/USD"), "XAUUSD")
  assertEquals(normalizeBacktestSymbol(" eurusd "), "EURUSD")
})

Deno.test("resolveBrokerSymbol never resolves a cross-currency quote variant", () => {
  // 2026-11-01: BTCAUDm was picked for a BTCUSD signal on an Exness suffix
  // server and the whole backtest simulated BTC in AUD.
  const symbols = ["BTCUSDTm", "BTCUSDm", "BTCAUDm", "BTCCNHm", "EURUSDm"]
  assertEquals(resolveBrokerSymbol("BTCUSD", symbols), "BTCUSDm")
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BTCAUDm", "BTCCNHm"]), null)
  assertEquals(resolveBrokerSymbol("BTC", ["BTCAUDm", "BTCCNHm"]), null)
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BTCAUDm", "BTCUSDTm"]), "BTCUSDTm")
  assertEquals(resolveBrokerSymbol("EURUSD", ["EURUSDm", "EURJPYm"]), "EURUSDm")
})

Deno.test("resolveBrokerSymbol accepts broker suffix tokens after a target", () => {
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BTCUSD.pro"]), "BTCUSD.pro")
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BTCUSDCASH"]), "BTCUSDCASH")
  assertEquals(resolveBrokerSymbol("XAUUSD", ["XAUUSDm"]), "XAUUSDm")
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BTCUSDM"]), "BTCUSDM")
  // Vocabulary from worker/src/tradeExecutor/brokerSymbolCache.ts decorations.
  assertEquals(resolveBrokerSymbol("EURUSD", ["EURUSD.S"]), "EURUSD.S")
  assertEquals(resolveBrokerSymbol("EURUSD", ["EURUSDC"]), "EURUSDC")
  assertEquals(resolveBrokerSymbol("XAUUSD", ["XAUUSD.STP"]), "XAUUSD.STP")
  assertEquals(resolveBrokerSymbol("GOLD", ["GOLD.cent"]), "GOLD.cent")
})

Deno.test("resolveBrokerSymbol shorter-root fallback prefers the longest root", () => {
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BT", "BTC"]), "BTC")
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BTC"]), "BTC")
  assertEquals(resolveBrokerSymbol("BTCUSD", ["BT"]), "BT")
})

Deno.test("parsePriceHistoryResponse parses FXsocket docs fixture", () => {
  const bars = parsePriceHistoryResponse([{
    time: "2026-06-11T08:00:00Z",
    open: 1.15301,
    high: 1.15348,
    low: 1.15289,
    close: 1.15330,
    tickVolume: 1243,
    realVolume: 0,
    spread: 7,
  }])
  assertEquals(bars.length, 1)
  assertEquals(bars[0]!.close, 1.15330)
  assertEquals(bars[0]!.tickVolume, 1243)
})

Deno.test("fxsocketBarsToMidPoints builds conservative bid/ask envelope", () => {
  const bars = parsePriceHistoryResponse([{
    time: "2026-06-11T08:00:00Z",
    open: 1.15301,
    high: 1.15348,
    low: 1.15289,
    close: 1.15330,
  }])
  const pts = fxsocketBarsToMidPoints(bars, 0)
  assertEquals(pts.length, 1)
  assertEquals(pts[0]!.bid, 1.15289)
  assertEquals(pts[0]!.ask, 1.15348)
  assertEquals(pts[0]!.mid, 1.15330)
})

Deno.test("parseQuoteTicksResponse and fxsocketTicksToMidPoints", () => {
  const ticks = parseQuoteTicksResponse([
    { time: "2026-06-11T08:55:56.728Z", bid: 1.15325, ask: 1.15333 },
    { time: "2026-06-11T08:55:57.100Z", bid: 1.15326, ask: 1.15334 },
  ])
  assertEquals(ticks.length, 2)
  const pts = fxsocketTicksToMidPoints(ticks, 0)
  assertEquals(pts.length, 2)
  assertEquals(pts[0]!.bid, 1.15325)
  assertEquals(pts[1]!.bid, 1.15326)
})

Deno.test("pickCandleIntervalMs adapts to duration and tick count", () => {
  assertEquals(pickCandleIntervalMs(10 * 60_000, 100), 5_000)
  assertEquals(pickCandleIntervalMs(2 * 60 * 60_000, 100), 30_000)
  assertEquals(pickCandleIntervalMs(12 * 60 * 60_000, 100), 5 * 60_000)
  const wide = pickCandleIntervalMs(60 * 60_000, 50_000)
  assertEquals(wide >= 7_200, true)
})

Deno.test("aggregateMidPointsToOhlc buckets ticks into OHLC", () => {
  const base = Date.parse("2026-06-11T08:55:56.000Z")
  const pts = fxsocketTicksToMidPoints([
    { time: "2026-06-11T08:55:56.100Z", bid: 1.10, ask: 1.12 },
    { time: "2026-06-11T08:55:56.900Z", bid: 1.09, ask: 1.13 },
    { time: "2026-06-11T08:55:57.200Z", bid: 1.11, ask: 1.14 },
  ], 0)
  const candles = aggregateMidPointsToOhlc(pts, 1_000)
  assertEquals(candles.length, 2)
  assertEquals(candles[0]!.time, Math.floor(base / 1000))
  assertEquals(candles[0]!.open, pts[0]!.mid)
  assertEquals(candles[0]!.close, pts[1]!.mid)
  assertEquals(candles[0]!.high, 1.13)
  assertEquals(candles[0]!.low, 1.09)
})

Deno.test("fxsocketMarketQueryRange uses broker server dates and ensures from < to", () => {
  const offset = 3 * 3600
  const fromMs = Date.parse("2026-06-11T22:00:00.000Z")
  const toMs = Date.parse("2026-06-11T23:00:00.000Z")
  const range = fxsocketMarketQueryRange(fromMs, toMs, offset, 0)
  assertEquals(range.from, msToFxsocketServerDate(fromMs, offset))
  assertEquals(range.from < range.to, true)
})

Deno.test("trimCandlesToTradeWindow removes pre-entry bars", () => {
  const signalMs = Date.parse("2026-06-16T09:48:00.000Z")
  const endMs = Date.parse("2026-06-16T09:49:30.000Z")
  const candles = [
    { time: Math.floor(Date.parse("2026-06-16T09:43:00.000Z") / 1000), open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: Math.floor(Date.parse("2026-06-16T09:48:00.000Z") / 1000), open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: Math.floor(Date.parse("2026-06-16T09:49:00.000Z") / 1000), open: 1.5, high: 2.5, low: 1, close: 2 },
  ]
  const trimmed = trimCandlesToTradeWindow(candles, signalMs, endMs, 60_000)
  assertEquals(trimmed.length, 2)
  assertEquals(trimmed[0]!.time, Math.floor(signalMs / 1000))
})
