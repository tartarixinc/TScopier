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

Deno.test("normalizeBacktestSymbol strips punctuation", () => {
  assertEquals(normalizeBacktestSymbol("XAU/USD"), "XAUUSD")
  assertEquals(normalizeBacktestSymbol(" eurusd "), "EURUSD")
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
