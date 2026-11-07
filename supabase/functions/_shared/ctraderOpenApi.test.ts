import { assertEquals } from "jsr:@std/assert"
import { applyStoredStopLevels, needsStopEnrichment, type CtraderTradeRow } from "./ctraderOpenApi.ts"

function closedRow(over: Partial<CtraderTradeRow> = {}): CtraderTradeRow {
  return {
    id: "b1:deal:1",
    broker_id: "b1",
    broker_label: "Spotware",
    broker_name: null,
    ticket: 300535660,
    symbol: "XAUUSD",
    direction: "buy",
    type: "Buy",
    lot_size: 0.01,
    entry_price: 3913.91,
    sl: null,
    tp: null,
    close_price: 3913.79,
    profit: -0.11,
    swap: 0,
    commission: -0.18,
    comment: "TScopier:TestSignal:135daf64",
    magic: null,
    opened_at: "2026-11-03T06:55:20.000Z",
    closed_at: "2026-11-03T06:56:13.000Z",
    state: null,
    status: "closed",
    ...over,
  }
}

const storedRow = {
  broker_account_id: "b1",
  metaapi_order_id: "300535660",
  sl: "3907.00000000",
  tp: "3928.00000000",
}

Deno.test("applyStoredStopLevels fills null stops on closed rows from the stored trade", () => {
  const rows = [closedRow()]
  const enriched = applyStoredStopLevels(rows, [storedRow])
  assertEquals(enriched, 1)
  assertEquals(rows[0].sl, 3907)
  assertEquals(rows[0].tp, 3928)
})

Deno.test("applyStoredStopLevels keys on broker account and ticket, ignoring cross-broker noise", () => {
  const rows = [closedRow()]
  const enriched = applyStoredStopLevels(rows, [
    { broker_account_id: "other-broker", metaapi_order_id: "300535660", sl: 1111, tp: 2222 },
    { broker_account_id: "b1", metaapi_order_id: "999999", sl: 3333, tp: 4444 },
  ])
  assertEquals(enriched, 0)
  assertEquals(rows[0].sl, null)
  assertEquals(rows[0].tp, null)
})

Deno.test("applyStoredStopLevels skips open rows, tickets without a stored match, and invalid stored stops", () => {
  const open = closedRow({ status: "open", sl: null, tp: null })
  const unknownTicket = closedRow({ ticket: 42 })
  const zeroSl = closedRow({ ticket: 43 })
  const rows = [open, unknownTicket, zeroSl]
  const enriched = applyStoredStopLevels(rows, [
    { broker_account_id: "b1", metaapi_order_id: "43", sl: "0.00000000", tp: "3928.00000000" },
  ])
  // open rows are never touched; unknown ticket never matches;
  // stored sl=0 means "unset" so only the tp of ticket 43 lands.
  assertEquals(rows[0].sl, null)
  assertEquals(rows[0].tp, null)
  assertEquals(rows[1].sl, null)
  assertEquals(rows[2].sl, null)
  assertEquals(rows[2].tp, 3928)
  assertEquals(enriched, 1)
})

Deno.test("applyStoredStopLevels never overwrites a stop the row already carries", () => {
  const rows = [closedRow({ sl: 3907, tp: null })]
  const enriched = applyStoredStopLevels(rows, [
    { broker_account_id: "b1", metaapi_order_id: "300535660", sl: 9999, tp: 8888 },
  ])
  assertEquals(rows[0].sl, 3907, "existing broker-sourced stop must win")
  assertEquals(rows[0].tp, 8888)
  assertEquals(enriched, 1)
})

Deno.test("applyStoredStopLevels ignores stored rows without a ticket or broker account", () => {
  const rows = [closedRow()]
  const enriched = applyStoredStopLevels(rows, [
    { broker_account_id: "b1", metaapi_order_id: null, sl: 1111, tp: 2222 },
    { broker_account_id: "", metaapi_order_id: "300535660", sl: 1111, tp: 2222 },
  ])
  assertEquals(enriched, 0)
  assertEquals(rows[0].sl, null)
  assertEquals(rows[0].tp, null)
})

Deno.test("needsStopEnrichment matches exactly the repairable rows", () => {
  assertEquals(needsStopEnrichment(closedRow()), true)
  assertEquals(needsStopEnrichment(closedRow({ status: "open" })), false, "open rows are broker-sourced")
  assertEquals(needsStopEnrichment(closedRow({ ticket: 0 })), false, "no ticket, nothing to join")
  assertEquals(needsStopEnrichment(closedRow({ sl: 3907, tp: 3928 })), false, "already complete")
  assertEquals(needsStopEnrichment(closedRow({ sl: 3907 })), true, "missing tp only")
})
