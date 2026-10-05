import { assertEquals, assertRejects } from "jsr:@std/assert"
import type { MtapiClient } from "../mtapiClient.ts"
import {
  createMtapiClockResolver,
  mt4HistoryTimeframe,
  type MtapiClockNormalization,
  MtapiHistoricalMarketData,
  mtapiTimeframeMinutes,
  normalizeMtapiBar,
  parseMtapiTimestamp,
  requestedMt4BarCount,
} from "./mtapiMarketData.ts"

const UTC_CLOCK: MtapiClockNormalization = {
  timestampMode: "utc",
  utcOffsetSeconds: 0,
}
const MINUTE_MS = 60_000

Deno.test("MTAPI timeframe mappings cover supported backtest intervals", () => {
  assertEquals(
    ["1m", "5m", "15m", "1h", "1d"].map((value) => mtapiTimeframeMinutes(value as "1m" | "5m" | "15m" | "1h" | "1d")),
    [1, 5, 15, 60, 1_440],
  )
  assertEquals(
    ["1m", "5m", "15m", "1h", "1d"].map((value) => mt4HistoryTimeframe(value as "1m" | "5m" | "15m" | "1h" | "1d")),
    ["M1", "M5", "M15", "H1", "D1"],
  )
})

Deno.test("MTAPI bar normalization accepts MT5 and defensive MT4 casing", () => {
  assertEquals(
    normalizeMtapiBar({
      time: "2025-01-01T00:00:00",
      openPrice: 1.1,
      highPrice: 1.3,
      lowPrice: 1,
      closePrice: 1.2,
      spread: 12,
    }, UTC_CLOCK),
    {
      ts: Date.parse("2025-01-01T00:00:00Z"),
      open: 1.1,
      high: 1.3,
      low: 1,
      close: 1.2,
      spread: 12,
    },
  )
  assertEquals(
    normalizeMtapiBar({
      Time: "2025-01-01T00:01:00",
      Open: "1.2",
      High: "1.4",
      Low: "1.1",
      Close: "1.3",
    }, UTC_CLOCK)?.close,
    1.3,
  )
})

Deno.test("malformed or ambiguous MTAPI bars are skipped", () => {
  const base = {
    time: "2025-01-01T00:00:00",
    openPrice: 1.1,
    highPrice: 1.3,
    lowPrice: 1,
    closePrice: 1.2,
  }
  assertEquals(normalizeMtapiBar({ ...base, highPrice: 0.9 }, UTC_CLOCK), null)
  assertEquals(
    normalizeMtapiBar({ ...base, openPrice: Number.NaN }, UTC_CLOCK),
    null,
  )
  assertEquals(normalizeMtapiBar({ ...base, Open: 9 }, UTC_CLOCK), null)
  assertEquals(normalizeMtapiBar({ ...base, time: "bad" }, UTC_CLOCK), null)
})

Deno.test("server-time fixtures apply only an explicitly supplied offset", () => {
  const clock: MtapiClockNormalization = {
    timestampMode: "server",
    utcOffsetSeconds: 2 * 3_600,
  }
  assertEquals(
    parseMtapiTimestamp("2025-01-01T02:00:00", clock),
    Date.parse("2025-01-01T00:00:00Z"),
  )
  assertEquals(
    parseMtapiTimestamp("2025-01-01T02:00:00Z", clock),
    Date.parse("2025-01-01T02:00:00Z"),
  )
})

Deno.test("clock resolution fails closed until timezone semantics are verified", async () => {
  const client = {} as MtapiClient
  const resolver = createMtapiClockResolver(client, { get: () => undefined })
  await assertRejects(
    () => resolver("redacted", "MT5"),
    Error,
    "timezone is not verified",
  )
})

Deno.test("MT5 PriceHistory is chunked, deduped, sorted, and cropped", async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    symbols: async () => ["EURUSD.pro"],
    priceHistory: async (_id: string, args: Record<string, unknown>) => {
      calls.push(args)
      const from = String(args.from)
      return [{
        time: from,
        openPrice: 1.1,
        highPrice: 1.3,
        lowPrice: 1,
        closePrice: 1.2,
      }, {
        // Deliberate cross-chunk duplicate exercises timestamp deduplication.
        time: "2025-01-01T00:00:00Z",
        openPrice: 1.1,
        highPrice: 1.3,
        lowPrice: 1,
        closePrice: 1.2,
      }]
    },
  } as unknown as MtapiClient
  const source = new MtapiHistoricalMarketData(client, async () => UTC_CLOCK)
  const fromMs = Date.parse("2025-01-01T00:00:00Z")
  const result = await source.historicalBars({
    sessionId: "redacted",
    platform: "MT5",
    symbol: "EURUSD.pro",
    timeframe: "1m",
    fromMs,
    toMs: fromMs + 8_001 * MINUTE_MS,
  })
  assertEquals(calls.length, 3)
  assertEquals(
    calls.every((call) => call.timeFrame === 1 && call.timeoutSeconds === 30),
    true,
  )
  assertEquals(result.requestCount, 3)
  assertEquals(result.data.length, 3)
  assertEquals(
    result.data.map((bar) => bar.ts).sort((a, b) => a - b),
    result.data.map((bar) => bar.ts),
  )
})

Deno.test("MT4 QuoteHistory uses bounded backwards count chunks", async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    symbols: async () => ["GOLD"],
    quoteHistory: async (_id: string, args: Record<string, unknown>) => {
      calls.push(args)
      return [{
        Time: String(args.from),
        Open: 2_000,
        High: 2_002,
        Low: 1_999,
        Close: 2_001,
      }]
    },
  } as unknown as MtapiClient
  const source = new MtapiHistoricalMarketData(client, async () => UTC_CLOCK)
  const fromMs = Date.parse("2025-01-01T00:00:00Z")
  const result = await source.historicalBars({
    sessionId: "redacted",
    platform: "MT4",
    symbol: "GOLD",
    timeframe: "1m",
    fromMs,
    toMs: fromMs + 8_001 * MINUTE_MS,
  })
  assertEquals(calls.length, 3)
  assertEquals(
    calls.every((call) => call.timeframe === "M1" && Number(call.count) <= 4_000),
    true,
  )
  assertEquals(result.requestCount, 3)
  assertEquals(result.data.length, 3)
  assertEquals(requestedMt4BarCount(fromMs, fromMs + 59 * MINUTE_MS, 1), 60)
})

Deno.test("verified server clock requires explicit unit, sign, and no-DST policy", async () => {
  const client = {
    serverTimezone: async () => 2,
  } as unknown as MtapiClient
  const values: Record<string, string> = {
    MTAPI_HISTORY_TIMEZONE_VERIFIED: "true",
    MTAPI_HISTORY_TIMESTAMP_MODE: "server",
    MTAPI_SERVER_TIMEZONE_UNIT: "hours",
    MTAPI_SERVER_TIMEZONE_SIGN: "server_minus_utc",
    MTAPI_SERVER_TIMEZONE_DST: "none",
  }
  const resolver = createMtapiClockResolver(client, { get: (name) => values[name] })
  assertEquals(await resolver("redacted", "MT5"), {
    timestampMode: "server",
    utcOffsetSeconds: 7_200,
  })

  delete values.MTAPI_SERVER_TIMEZONE_DST
  const unsafeResolver = createMtapiClockResolver(client, { get: (name) => values[name] })
  await assertRejects(
    () => unsafeResolver("redacted", "MT5"),
    Error,
    "DST policy has not been explicitly verified",
  )
})
