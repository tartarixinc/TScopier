import { assertEquals } from "jsr:@std/assert"
import { selectPointsForTradeWindow } from "./tradeReplayData.ts"
import type { PricePoint } from "./simulator.ts"

Deno.test("selectPointsForTradeWindow keeps only in-trade ticks", () => {
  const pts: PricePoint[] = [
    { ts: 1000, bid: 1, ask: 1.1, mid: 1.05 },
    { ts: 2000, bid: 1, ask: 1.1, mid: 1.05 },
    { ts: 3000, bid: 1, ask: 1.1, mid: 1.05 },
  ]
  assertEquals(selectPointsForTradeWindow(pts, 1500, 2500).length, 1)
  assertEquals(selectPointsForTradeWindow(pts, 5000, 6000).length, 0)
})
