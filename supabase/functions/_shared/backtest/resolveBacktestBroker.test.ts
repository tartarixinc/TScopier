import { assertEquals, assertRejects } from "jsr:@std/assert"
import { resolveBrokerSymbol } from "./fxsocketMarketData.ts"
import {
  BacktestBrokerNotFoundError,
  BacktestSymbolNotFoundError,
  resolveBacktestBroker,
} from "./resolveBacktestBroker.ts"
import type { FxsocketClient } from "../fxsocketClient.ts"

Deno.test("resolveBacktestBroker throws when user has no linked brokers", async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({
              order: async () => ({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
  }

  const fx = { symbols: async () => [] } as unknown as FxsocketClient

  await assertRejects(
    async () => {
      await resolveBacktestBroker(supabase as never, fx, "user-1", "EURUSD")
    },
    BacktestBrokerNotFoundError,
    "Connect an MT5 broker",
  )
})

Deno.test("resolveBacktestBroker picks broker with matching symbol", async () => {
  const brokerRow = {
    id: "broker-uuid",
    label: "Demo IC",
    fxsocket_account_id: "11111111-2222-3333-4444-555555555555",
    fxsocket_status: "connected",
    connection_status: "connected",
    is_active: true,
  }

  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({
              order: async () => ({ data: [brokerRow], error: null }),
            }),
          }),
        }),
      }),
    }),
  }

  const fx = {
    symbols: async () => ["EURUSD.sd", "GBPUSD.sd"],
  } as unknown as FxsocketClient

  const ctx = await resolveBacktestBroker(supabase as never, fx, "user-1", "EURUSD")
  assertEquals(ctx.brokerAccountId, "broker-uuid")
  assertEquals(ctx.fxsocketAccountId, "11111111-2222-3333-4444-555555555555")
  assertEquals(resolveBrokerSymbol("EURUSD", ctx.brokerSymbols), "EURUSD.sd")
})

Deno.test("resolveBacktestBroker throws when symbol missing on all brokers", async () => {
  const brokerRow = {
    id: "broker-uuid",
    label: "Demo",
    fxsocket_account_id: "11111111-2222-3333-4444-555555555555",
    fxsocket_status: "connected",
    connection_status: "connected",
    is_active: true,
  }

  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({
              order: async () => ({ data: [brokerRow], error: null }),
            }),
          }),
        }),
      }),
    }),
  }

  const fx = {
    symbols: async () => ["GBPUSD.sd"],
  } as unknown as FxsocketClient

  await assertRejects(
    async () => {
      await resolveBacktestBroker(supabase as never, fx, "user-1", "XAUUSD")
    },
    BacktestSymbolNotFoundError,
  )
})
