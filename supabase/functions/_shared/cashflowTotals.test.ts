import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { CASHFLOW_SYNC_INTERVAL_MS, cashflowSyncDue, summarizeCashFlow } from "./cashflowTotals.ts"

Deno.test("summarizeCashFlow splits deposits and withdrawals", () => {
  const totals = summarizeCashFlow([{ profit: 50000 }, { profit: 2500.5 }, { profit: -1000.25 }, { profit: 0 }, { profit: null }])
  assertEquals(totals, { deposits: 52500.5, withdrawals: 1000.25, found: true })
})

Deno.test("summarizeCashFlow reports nothing found for empty or zero history", () => {
  assertEquals(summarizeCashFlow([]), { deposits: 0, withdrawals: 0, found: false })
  assertEquals(summarizeCashFlow([{ profit: 0 }]).found, false)
})

Deno.test("cashflowSyncDue throttles to the sync interval", () => {
  const now = Date.parse("2026-11-01T12:00:00Z")
  assertEquals(cashflowSyncDue(null, now), true)
  assertEquals(cashflowSyncDue("garbage", now), true)
  assertEquals(cashflowSyncDue(new Date(now - CASHFLOW_SYNC_INTERVAL_MS + 1000).toISOString(), now), false)
  assertEquals(cashflowSyncDue(new Date(now - CASHFLOW_SYNC_INTERVAL_MS).toISOString(), now), true)
})
