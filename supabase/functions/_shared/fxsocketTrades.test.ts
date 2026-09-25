import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  fetchFxsocketBrokerTrades,
  fetchTradesListFromOrderHistory,
  mapPositionHistoryRow,
  type MtHistorySource,
} from "./fxsocketTrades.ts"

const broker = {
  id: "broker-1",
  label: "Demo",
  broker_name: "FxPro",
}

const sessionBroker = {
  id: "broker-mtapi",
  label: "MT5 • 476205231",
  broker_name: null,
  platform: "MT5",
  fxsocket_account_id: "sess-mtapi-1",
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

// ── MTAPI OrderHistory source (captured bridge row) ───────────────────────

const mtapiClosedOrder = {
  ticket: 3276777659,
  lots: 0.01,
  closeLots: 0.01,
  volume: 1000000,
  closeVolume: 1000000,
  openPrice: 4264.219,
  closePrice: 4276,
  openTime: "2026-09-24T11:30:12.178",
  closeTime: "2026-09-24T12:50:16.778",
  openTimestampUTC: 1790249412178,
  closeTimestampUTC: 1790254216778,
  orderType: "Sell",
  dealType: "DealSell",
  state: "Filled",
  symbol: "XAUUSDm",
  profit: -11.78,
  swap: 0,
  commission: 0,
  stopLoss: 4300,
  takeProfit: 4200,
  comment: "TScopier:ch:4354ff31",
  dealInternalIn: {
    ticket: 3276777650,
    lots: 0.01,
    volume: 1000000,
    type: "DealSell",
    direction: "In",
    openTime: "2026-09-24T11:30:12.178",
  },
  dealInternalOut: {
    ticket: 3276777659,
    lots: 0.01,
    volume: 1000000,
    type: "DealBuy",
    direction: "Out",
    closeTime: "2026-09-24T12:50:16.778",
    profit: -11.78,
  },
}

const mtapiOpenOrder = {
  ticket: 3290000001,
  lots: 0.01,
  closeLots: 0,
  volume: 1000000,
  closeVolume: 0,
  openPrice: 4264.219,
  openTime: "2026-09-25T09:00:00.000",
  openTimestampUTC: 1790300000000,
  closeTime: "0001-01-01T00:00:00",
  closeTimestampUTC: 0,
  orderType: "Sell",
  dealType: "DealSell",
  state: "Filled",
  symbol: "XAUUSDm",
  profit: 0,
  stopLoss: 4300,
  takeProfit: 4200,
  comment: "",
  dealInternalIn: {
    ticket: 3290000000,
    lots: 0.01,
    volume: 1000000,
    type: "DealSell",
    direction: "In",
    openTime: "2026-09-25T09:00:00.000",
  },
}

const tradesOpts = {
  scope: "all",
  historyFrom: "2000-01-01T00:00:00",
  historyTo: "2026-09-25T12:00:00",
  historyProfile: "trades",
  limit: 0,
  includeBalanceCashFlow: false,
} as const

Deno.test("fetchFxsocketBrokerTrades: MTAPI source reads closed rows from OrderHistory", async () => {
  const source: MtHistorySource = {
    openedOrders: async () => [mtapiOpenOrder],
    orderHistory: async () => [mtapiClosedOrder],
    positionHistory: async () => {
      throw new Error("ORDER_HISTORY_NOT_READY")
    },
    closedHistorySource: "order_history",
  }

  const trades = await fetchFxsocketBrokerTrades(source, sessionBroker, tradesOpts)
  assertEquals(trades.length, 2)

  const open = trades.find(t => t.status === "open")
  const closed = trades.find(t => t.status === "closed")
  assertNotEquals(open, undefined)
  assertNotEquals(closed, undefined)

  // Zero-shadow fix: closeLots/closeVolume 0 must not mask lots 0.01.
  assertEquals(open!.lot_size, 0.01)
  assertEquals(open!.symbol, "XAUUSDm")

  assertEquals(closed!.ticket, 3276777659)
  assertEquals(closed!.lot_size, 0.01)
  assertEquals(closed!.symbol, "XAUUSDm")
  // OUT deal on a sell position reads Buy — direction must stay the side of the entry.
  assertEquals(closed!.direction, "sell")
  assertEquals(closed!.profit, -11.78)
  assertEquals(closed!.entry_price, 4264.219)
  assertEquals(
    closed!.closed_at,
    new Date(Date.parse("2026-09-24T12:50:16.778")).toISOString(),
  )
})

Deno.test("fetchFxsocketBrokerTrades: default source keeps PositionHistory closed rows", async () => {
  const source: MtHistorySource = {
    openedOrders: async () => [],
    orderHistory: async () => {
      throw new Error("OrderHistory must not be used without closedHistorySource")
    },
    positionHistory: async () => [swaggerPositionRow],
  }

  const trades = await fetchFxsocketBrokerTrades(source, sessionBroker, tradesOpts)
  assertEquals(trades.length, 1)
  assertEquals(trades[0].ticket, 1679874108)
  assertEquals(trades[0].direction, "sell")
  assertEquals(trades[0].lot_size, 0.01)
})

Deno.test("fetchTradesListFromOrderHistory: open orders and balance rows are skipped", async () => {
  const source: MtHistorySource = {
    openedOrders: async () => [],
    orderHistory: async () => [
      // Open order echoed by the history feed (close time at epoch start).
      { ...mtapiOpenOrder, ticket: 3290000002 },
      // Balance-style row: no symbol, no size — never a trade row.
      {
        ticket: 777,
        symbol: "",
        lots: 0,
        volume: 0,
        closeLots: 0,
        closeTime: "2026-09-24T08:00:00.000",
        type: "Balance",
        profit: 500,
      },
      mtapiClosedOrder,
    ],
    positionHistory: async () => {
      throw new Error("not used")
    },
    closedHistorySource: "order_history",
  }

  const rows = await fetchTradesListFromOrderHistory(source, sessionBroker, {
    historyFrom: tradesOpts.historyFrom,
    historyTo: tradesOpts.historyTo,
  })
  assertEquals(rows.length, 1)
  assertEquals(rows[0].ticket, 3276777659)
})
