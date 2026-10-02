import { assertEquals, assertRejects } from "jsr:@std/assert"
import { MtapiApiError } from "../mtapiClient.ts"
import type { HistoricalMarketDataSource } from "./historicalMarketData.ts"
import { historicalBarsToPricePoints } from "./historicalMarketData.ts"
import { fetchBarsForSymbol, fetchTicksForSymbol } from "./marketData.ts"
import type { BacktestBrokerContext } from "./resolveBacktestBroker.ts"

const bar = {
  ts: Date.parse("2025-01-01T00:00:00Z"),
  open: 1.1,
  high: 1.3,
  low: 1,
  close: 1.2,
}

const context: BacktestBrokerContext = {
  brokerAccountId: "broker-redacted",
  brokerLabel: "Demo",
  provider: "mtapi",
  sessionId: "session-redacted",
  platform: "MT5",
  brokerSymbols: ["EURUSD.pro"],
}

Deno.test("normalized OHLC preserves conservative PricePoint conversion", () => {
  assertEquals(historicalBarsToPricePoints([bar]), [{
    ts: bar.ts,
    bid: bar.low,
    ask: bar.high,
    mid: bar.close,
  }])
})

Deno.test("same normalized bars produce identical simulator points for either provider", () => {
  const fromMtapi = historicalBarsToPricePoints([bar])
  const fromFxsocket = historicalBarsToPricePoints([{ ...bar }])
  assertEquals(fromMtapi, fromFxsocket)
})

Deno.test("MTAPI tick request explicitly falls back without a fetch failure", async () => {
  const source: HistoricalMarketDataSource = {
    provider: "mtapi",
    symbols: async () => ["EURUSD.pro"],
    historicalBars: async () => ({ data: [bar], requestCount: 1 }),
  }
  const result = await fetchTicksForSymbol(
    source,
    context,
    "EURUSD.pro",
    bar.ts,
    bar.ts + 60_000,
  )
  assertEquals(result.pts, [])
  assertEquals(result.apiCalls, 0)
  assertEquals(result.failed, false)
  assertEquals(result.log.includes("using OHLC bars"), true)
})

Deno.test("provider-neutral bar fetch maps normalized history for simulation", async () => {
  const source: HistoricalMarketDataSource = {
    provider: "mtapi",
    symbols: async () => ["EURUSD.pro"],
    historicalBars: async (request) => {
      assertEquals(request.sessionId, "session-redacted")
      assertEquals(request.timeframe, "5m")
      return { data: [bar], requestCount: 2 }
    },
  }
  const result = await fetchBarsForSymbol(
    source,
    context,
    "EURUSD.pro",
    "5m",
    bar.ts,
    bar.ts + 60_000,
  )
  assertEquals(result.pts, [{ ts: bar.ts, bid: 1, ask: 1.3, mid: 1.2 }])
  assertEquals(result.apiCalls, 2)
  assertEquals(result.failed, false)
})

Deno.test("unverified MTAPI timezone aborts instead of becoming no-data", async () => {
  const source: HistoricalMarketDataSource = {
    provider: "mtapi",
    symbols: async () => ["EURUSD.pro"],
    historicalBars: async () => {
      throw new MtapiApiError(
        "timezone is not verified",
        503,
        "MTAPI_HISTORY_TIMEZONE_UNVERIFIED",
      )
    },
  }
  await assertRejects(
    () =>
      fetchBarsForSymbol(
        source,
        context,
        "EURUSD.pro",
        "5m",
        bar.ts,
        bar.ts + 60_000,
      ),
    MtapiApiError,
    "timezone is not verified",
  )
})
