import { assertEquals } from "jsr:@std/assert"
import {
  inferPerformanceBaselineFromHistory,
  resolvePerformanceBaselineBalance,
  splitBalanceCashFlows,
  sumRealizedClosedDealProfit,
  sumRealizedClosedNetProfit,
} from "./performanceBaseline.ts"
import type { FxsocketBrokerTradeRow } from "./fxsocketTrades.ts"

function trade(overrides: Partial<FxsocketBrokerTradeRow>): FxsocketBrokerTradeRow {
  const ticket = overrides.ticket ?? 1
  return {
    id: `broker-1:${ticket}`,
    broker_id: "broker-1",
    broker_label: "Demo",
    broker_name: "IC Markets",
    ticket,
    symbol: "XAUUSD",
    direction: "buy",
    type: "Buy",
    lot_size: 0.1,
    entry_price: 2500,
    sl: null,
    tp: null,
    close_price: 2510,
    profit: 100,
    swap: 0,
    commission: 0,
    comment: null,
    magic: null,
    opened_at: "2026-01-01T10:00:00",
    closed_at: "2026-01-02T10:00:00",
    state: null,
    status: "closed",
    ...overrides,
  }
}

Deno.test("resolvePerformanceBaselineBalance captures balance on first link", () => {
  const baseline = resolvePerformanceBaselineBalance(null, { balance: 10_000, equity: 10_000 })
  assertEquals(baseline, 10_000)
})

Deno.test("resolvePerformanceBaselineBalance skips when baseline already correct", () => {
  const baseline = resolvePerformanceBaselineBalance(10_000, { balance: 12_000 })
  assertEquals(baseline, null)
})

Deno.test("inferPerformanceBaselineFromHistory reconstructs from closed deal profit", () => {
  const trades = [
    trade({ ticket: 1, profit: -500 }),
    trade({ ticket: 2, profit: 200 }),
  ]
  assertEquals(sumRealizedClosedDealProfit(trades), -300)
  assertEquals(sumRealizedClosedNetProfit(trades), -300)
  assertEquals(inferPerformanceBaselineFromHistory(9_700, trades), 10_000)
})

Deno.test("resolvePerformanceBaselineBalance matches MT5 deposit (profit + swap)", () => {
  const trades = [trade({ ticket: 1, profit: -45_378.67, swap: 111.66 })]
  assertEquals(Math.round(sumRealizedClosedNetProfit(trades) * 100) / 100, -45_267.01)
  const baseline = resolvePerformanceBaselineBalance(
    null,
    { balance: 164_732.99, equity: 164_732.99 },
    trades,
  )
  assertEquals(baseline, 210_000)
})

Deno.test("resolvePerformanceBaselineBalance keeps stored baseline when no deposit row", () => {
  const trades = [trade({ ticket: 1, profit: -45_378.67, swap: 111.66 })]
  const baseline = resolvePerformanceBaselineBalance(
    210_111.66,
    { balance: 164_732.99, equity: 164_732.99 },
    trades,
  )
  assertEquals(baseline, null)
})

Deno.test("resolvePerformanceBaselineBalance corrects understated baseline from spurious cash-flow row", () => {
  const trades = [
    trade({
      ticket: 0,
      symbol: "",
      direction: "",
      type: "Balance",
      lot_size: 0,
      profit: 210_000,
      closed_at: "2026-01-01T08:00:00",
    }),
    trade({
      ticket: 1,
      profit: -45_378.67,
      swap: 111.66,
      closed_at: "2026-06-12T16:16:47",
    }),
    trade({
      ticket: 2,
      symbol: "",
      direction: "",
      type: "",
      lot_size: 0,
      profit: 855.94,
      closed_at: "2026-06-12T16:16:47",
    }),
  ]
  const baseline = resolvePerformanceBaselineBalance(
    209_144.06,
    { balance: 164_732.99, equity: 164_732.99 },
    trades,
  )
  assertEquals(baseline, 210_000)
})

Deno.test("inferPerformanceBaselineFromHistory prefers MT5 deposit over short inference", () => {
  const trades = [
    trade({
      ticket: 0,
      symbol: "",
      direction: "",
      type: "Balance",
      lot_size: 0,
      profit: 210_000,
      closed_at: "2026-01-01T08:00:00",
    }),
    trade({ ticket: 1, profit: -45_378.67, swap: 111.66, closed_at: "2026-06-12T16:16:47" }),
  ]
  assertEquals(inferPerformanceBaselineFromHistory(163_877.05, trades), 210_000)
})

Deno.test("splitBalanceCashFlows separates initial deposit from later withdrawals", () => {
  const trades = [
    trade({
      ticket: 0,
      symbol: "",
      direction: "",
      type: "Balance",
      lot_size: 0,
      profit: 210_000,
      closed_at: "2026-01-01T08:00:00",
    }),
    trade({ ticket: 1, profit: -100, closed_at: "2026-02-01T10:00:00" }),
    trade({
      ticket: 2,
      symbol: "",
      direction: "",
      type: "Balance",
      lot_size: 0,
      profit: -5_000,
      closed_at: "2026-03-01T10:00:00",
    }),
  ]
  assertEquals(splitBalanceCashFlows(trades), {
    initialDeposit: 210_000,
    subsequentCashFlow: -5_000,
  })
  assertEquals(inferPerformanceBaselineFromHistory(204_900, trades), 210_000)
})
