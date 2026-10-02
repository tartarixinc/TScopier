import { assertEquals } from "jsr:@std/assert"
import { createHistoricalMarketDataSources } from "./marketDataSources.ts"

function env(values: Record<string, string>): Deno.Env {
  return {
    get: (name: string) => values[name],
  } as unknown as Deno.Env
}

Deno.test("MTAPI backtest source does not require FXSOCKET_API_KEY", () => {
  const sources = createHistoricalMarketDataSources(env({
    MTAPI_MT5_BASE_URL: "https://mtapi.invalid",
  }))
  assertEquals(sources.mtapi?.provider, "mtapi")
  assertEquals(sources.fxsocket, undefined)
})

Deno.test("FXSocket source remains available during provider migration", () => {
  const sources = createHistoricalMarketDataSources(env({
    FXSOCKET_API_KEY: "test-key",
  }))
  assertEquals(sources.fxsocket?.provider, "fxsocket")
  assertEquals(sources.mtapi, undefined)
})
