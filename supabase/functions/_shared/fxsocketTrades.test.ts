import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { mapPositionHistoryRow } from "./fxsocketTrades.ts"

const broker = {
  id: "broker-1",
  label: "Demo",
  broker_name: "FxPro",
}

const swaggerPositionRow = {
  positionId: 1679874108,
  symbol: "XAUUSD",
  type: "Sell",
  volume: 0.01,
  openTime: "2026-06-02T10:55:57.000Z",
  openPrice: 4532.59,
  closeTime: "2026-06-02T11:13:04.000Z",
  closePrice: 4536.6,
  profit: -4.01,
  swap: 0,
  commission: 0,
  netProfit: -4.01,
  magic: 1780386957639,
  comment: "TScopier:SIGNALSPRO:146acbf8",
}

Deno.test("mapPositionHistoryRow: Swagger fixture maps timestamps and lot size", () => {
  const trade = mapPositionHistoryRow(swaggerPositionRow, broker)
  assertNotEquals(trade, null)
  assertEquals(trade!.ticket, 1679874108)
  assertEquals(trade!.position_ticket, 1679874108)
  assertEquals(trade!.opened_at, "2026-06-02T10:55:57.000Z")
  assertEquals(trade!.closed_at, "2026-06-02T11:13:04.000Z")
  assertEquals(trade!.lot_size, 0.01)
  assertEquals(trade!.symbol, "XAUUSD")
  assertEquals(trade!.direction, "sell")
  assertEquals(trade!.profit, -4.01)
  assertEquals(trade!.status, "closed")
})

Deno.test("mapPositionHistoryRow: two positions yield two independent rows", () => {
  const rowA = { ...swaggerPositionRow, positionId: 100, volume: 0.01 }
  const rowB = { ...swaggerPositionRow, positionId: 101, volume: 0.02 }
  const tradeA = mapPositionHistoryRow(rowA, broker)
  const tradeB = mapPositionHistoryRow(rowB, broker)
  assertNotEquals(tradeA, null)
  assertNotEquals(tradeB, null)
  assertEquals(tradeA!.ticket, 100)
  assertEquals(tradeB!.ticket, 101)
  assertEquals(tradeA!.lot_size, 0.01)
  assertEquals(tradeB!.lot_size, 0.02)
})

Deno.test("mapPositionHistoryRow: unix closeTime seconds", () => {
  const row = {
    ...swaggerPositionRow,
    closeTime: 1_749_459_184,
    openTime: 1_749_458_157,
  }
  const trade = mapPositionHistoryRow(row, broker)
  assertNotEquals(trade, null)
  assertEquals(trade!.closed_at, new Date(1_749_459_184_000).toISOString())
})

Deno.test("mapPositionHistoryRow: missing closeTime skips row", () => {
  const { closeTime: _omit, ...withoutClose } = swaggerPositionRow
  const trade = mapPositionHistoryRow(withoutClose, broker)
  assertEquals(trade, null)
})

Deno.test("mapPositionHistoryRow: closed_at parses to displayable time", () => {
  const trade = mapPositionHistoryRow(swaggerPositionRow, broker)
  assertNotEquals(trade, null)
  const ms = Date.parse(trade!.closed_at!)
  assertEquals(Number.isFinite(ms), true)
  const label = new Date(ms).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  assertNotEquals(label.trim(), "")
})
