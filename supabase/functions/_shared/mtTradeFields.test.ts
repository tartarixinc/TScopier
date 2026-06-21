import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  resolveMtCloseTimestamp,
  resolveMtLots,
  resolveMtOpenTimestamp,
  ingestMtHistoryRows,
} from "./mtTradeFields.ts"

Deno.test("resolveMtLots: partial OUT deal uses deal volume not position size", () => {
  const lots = resolveMtLots({
    ticket: 9001,
    volume: 5000,
    position: { lots: 5, volume: 50000 },
    dealInternalIn: { ticket: 5001, lots: 5 },
  }, "trades")
  assertEquals(lots, 0.5)
})

Deno.test("resolveMtLots: position history row keeps full round-trip size", () => {
  const lots = resolveMtLots({
    ticket: 5001,
    lots: 5,
    volume: 50000,
  }, "trades")
  assertEquals(lots, 5)
})

Deno.test("ingestMtHistoryRows: keeps separate partial close deals", () => {
  const target = new Map<string, Record<string, unknown>>()
  ingestMtHistoryRows(target, [
    { ticket: 101, volume: 50, time: "2026-06-14T10:00:00Z" },
    { ticket: 102, volume: 50, time: "2026-06-14T11:00:00Z" },
  ], "trades")
  assertEquals(target.size, 2)
})

Deno.test("resolveMtCloseTimestamp: OPEN_TIME dot-format string", () => {
  const iso = resolveMtCloseTimestamp(
    { ticket: 1, CLOSE_TIME: "2025.01.15 20:54:24.928" },
    "trades",
  )
  assertEquals(iso, new Date("2025-01-15T20:54:24.928").toISOString())
})

Deno.test("resolveMtOpenTimestamp: OPEN_TIME dot-format string", () => {
  const iso = resolveMtOpenTimestamp(
    { ticket: 1, OPEN_TIME: "2025.01.15 20:51:41.117" },
    "trades",
  )
  assertEquals(iso, new Date("2025-01-15T20:51:41.117").toISOString())
})

Deno.test("resolveMtCloseTimestamp: FxSocket PositionHistory closeTime with ms", () => {
  const iso = resolveMtCloseTimestamp(
    { positionId: 1679874108, closeTime: "2026-06-02T11:13:04.000Z" },
    "trades",
  )
  assertEquals(iso, "2026-06-02T11:13:04.000Z")
})

Deno.test("resolveMtOpenTimestamp: FxSocket PositionHistory openTime with ms", () => {
  const iso = resolveMtOpenTimestamp(
    { positionId: 1679874108, openTime: "2026-06-02T10:55:57.000Z" },
    "trades",
  )
  assertEquals(iso, "2026-06-02T10:55:57.000Z")
})

Deno.test("resolveMtCloseTimestamp: FxSocket OrderHistory ISO time", () => {
  const iso = resolveMtCloseTimestamp(
    { ticket: 1401725372, time: "2026-06-14T14:13:01Z" },
    "trades",
  )
  assertEquals(iso, "2026-06-14T14:13:01.000Z")
})

Deno.test("resolveMtCloseTimestamp: MT5 deal time unix seconds", () => {
  const iso = resolveMtCloseTimestamp({ ticket: 1, time: 1_718_380_800 }, "trades")
  assertEquals(iso, new Date(1_718_380_800_000).toISOString())
})

Deno.test("resolveMtCloseTimestamp: closeTime string", () => {
  const iso = resolveMtCloseTimestamp(
    { ticket: 1, closeTime: "2026-06-14T14:13:01" },
    "trades",
  )
  assertEquals(iso, new Date("2026-06-14T14:13:01").toISOString())
})

Deno.test("resolveMtOpenTimestamp: nested dealInternalIn open time", () => {
  const iso = resolveMtOpenTimestamp({
    ticket: 2,
    time: 1_718_390_000,
    dealInternalIn: { openTime: "2026-06-14T12:00:00" },
  }, "trades")
  assertEquals(iso, new Date("2026-06-14T12:00:00").toISOString())
})

Deno.test("resolveMtOpenTimestamp: does not use top-level time on trades profile", () => {
  const iso = resolveMtOpenTimestamp({ ticket: 3, time: 1_718_380_800 }, "trades")
  assertEquals(iso, null)
})
