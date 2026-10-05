import { assertEquals, assertRejects } from "jsr:@std/assert"
import type { HistoricalMarketDataSource, HistoricalMarketDataSources } from "./historicalMarketData.ts"
import { resolveBrokerSymbol } from "./fxsocketMarketData.ts"
import {
  BacktestBrokerNotFoundError,
  BacktestProviderAuthorityError,
  BacktestSymbolNotFoundError,
  resolveBacktestBroker,
} from "./resolveBacktestBroker.ts"

function supabaseWith(rows: Record<string, unknown>[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
    }),
  }
}

function broker(overrides: Record<string, unknown> = {}) {
  return {
    id: "broker-uuid",
    label: "Demo",
    provider: "mtapi",
    platform: "MT5",
    fxsocket_account_id: "11111111-2222-3333-4444-555555555555",
    mtapi_session_id: "mtapi-session-secret",
    fxsocket_status: "connected",
    mtapi_status: "connected",
    connection_status: "connected",
    provider_transition_state: "stable",
    is_active: true,
    ...overrides,
  }
}

function source(
  provider: "mtapi" | "fxsocket",
  symbols: string[],
  onSymbols?: (sessionId: string, platform: string | null) => void,
): HistoricalMarketDataSource {
  return {
    provider,
    symbols: async (sessionId, platform) => {
      onSymbols?.(sessionId, platform)
      return symbols
    },
    historicalBars: async () => ({ data: [], requestCount: 0 }),
  }
}

Deno.test("resolveBacktestBroker throws when user has no linked brokers", async () => {
  await assertRejects(
    () => resolveBacktestBroker(supabaseWith([]) as never, {}, "user-1", "EURUSD"),
    BacktestBrokerNotFoundError,
    "Connect an MT4/MT5 broker",
  )
})

Deno.test("MTAPI authority uses MTAPI symbols without FXSocket configuration", async () => {
  let mtapiCalls = 0
  let fxCalls = 0
  const sources: HistoricalMarketDataSources = {
    mtapi: source("mtapi", ["EURUSD.sd"], (sessionId, platform) => {
      mtapiCalls += 1
      assertEquals(sessionId, "mtapi-session-secret")
      assertEquals(platform, "MT5")
    }),
    fxsocket: source("fxsocket", ["EURUSD"], () => fxCalls += 1),
  }
  const ctx = await resolveBacktestBroker(
    supabaseWith([broker()]) as never,
    sources,
    "user-1",
    "EURUSD",
  )
  assertEquals(ctx.provider, "mtapi")
  assertEquals(ctx.sessionId, "mtapi-session-secret")
  assertEquals(resolveBrokerSymbol("EURUSD", ctx.brokerSymbols), "EURUSD.sd")
  assertEquals(mtapiCalls, 1)
  assertEquals(fxCalls, 0)
})

Deno.test("prepared MTAPI session is not selected while provider remains FXSocket", async () => {
  let mtapiCalls = 0
  let fxCalls = 0
  const sources: HistoricalMarketDataSources = {
    mtapi: source("mtapi", ["XAUUSD.pro"], () => mtapiCalls += 1),
    fxsocket: source("fxsocket", ["GOLD"], (sessionId) => {
      fxCalls += 1
      assertEquals(sessionId, "11111111-2222-3333-4444-555555555555")
    }),
  }
  const ctx = await resolveBacktestBroker(
    supabaseWith([broker({ provider: "fxsocket", platform: "MT4" })]) as never,
    sources,
    "user-1",
    "XAUUSD",
  )
  assertEquals(ctx.provider, "fxsocket")
  assertEquals(resolveBrokerSymbol("XAUUSD", ctx.brokerSymbols), "GOLD")
  assertEquals(fxCalls, 1)
  assertEquals(mtapiCalls, 0)
})

Deno.test("transitioning provider fails closed without probing either provider", async () => {
  let calls = 0
  const sources: HistoricalMarketDataSources = {
    mtapi: source("mtapi", ["EURUSD"], () => calls += 1),
    fxsocket: source("fxsocket", ["EURUSD"], () => calls += 1),
  }
  await assertRejects(
    () => resolveBacktestBroker(
      supabaseWith([broker({ provider_transition_state: "transition" })]) as never,
      sources,
      "user-1",
      "EURUSD",
    ),
    BacktestProviderAuthorityError,
    "transition is in progress",
  )
  assertEquals(calls, 0)
})

Deno.test("MTAPI resolution does not require an FXSocket account id", async () => {
  const ctx = await resolveBacktestBroker(
    supabaseWith([broker({ fxsocket_account_id: "" })]) as never,
    { mtapi: source("mtapi", ["XAUUSDm"]) },
    "user-1",
    "XAUUSD",
  )
  assertEquals(ctx.provider, "mtapi")
  assertEquals(resolveBrokerSymbol("XAUUSD", ctx.brokerSymbols), "XAUUSDm")
})

Deno.test("missing symbol on authoritative provider throws", async () => {
  await assertRejects(
    () => resolveBacktestBroker(
      supabaseWith([broker()]) as never,
      { mtapi: source("mtapi", ["GBPUSD.sd"]) },
      "user-1",
      "XAUUSD",
    ),
    BacktestSymbolNotFoundError,
  )
})

Deno.test("authoritative provider symbols failure is surfaced distinctly", async () => {
  const failing: HistoricalMarketDataSource = {
    provider: "mtapi",
    symbols: async () => { throw new Error("session down") },
    historicalBars: async () => ({ data: [], requestCount: 0 }),
  }
  await assertRejects(
    () => resolveBacktestBroker(
      supabaseWith([broker()]) as never,
      { mtapi: failing },
      "user-1",
      "EURUSD",
    ),
    BacktestBrokerNotFoundError,
    "Could not load Market Watch symbols",
  )
})

Deno.test("MTAPI resolution requires an explicit MT4 or MT5 platform", async () => {
  await assertRejects(
    () => resolveBacktestBroker(
      supabaseWith([broker({ platform: null })]) as never,
      { mtapi: source("mtapi", ["EURUSD"]) },
      "user-1",
      "EURUSD",
    ),
    BacktestProviderAuthorityError,
    "platform is unavailable",
  )
})

Deno.test("unknown authoritative provider fails closed", async () => {
  await assertRejects(
    () => resolveBacktestBroker(
      supabaseWith([broker({ provider: "unknown" })]) as never,
      { mtapi: source("mtapi", ["EURUSD"]) },
      "user-1",
      "EURUSD",
    ),
    BacktestProviderAuthorityError,
    "unsupported active provider",
  )
})
