import { assertEquals } from "jsr:@std/assert"
import { MARKET_DATA_MAX_GAP, simulateTradeOnSeries } from "./simulator.ts"
import type { ParsedSignalForBacktest } from "./types.ts"

const strategy = {
  breakevenAfterTp: 0,
  partialClosePerTp: 0,
  intrabarPriority: "sl_first" as const,
}

function btcLikeSignal(overrides: Partial<ParsedSignalForBacktest> = {}): ParsedSignalForBacktest {
  return {
    signalId: "sig-1",
    copierSignalId: null,
    channelId: "ch-1",
    channelName: "test",
    signalAt: new Date("2026-10-25T11:04:00Z"),
    symbol: "BTCUSD",
    direction: "buy",
    entryPrice: 0,
    sl: 80900,
    tpLevels: [81400],
    lotSize: 0.01,
    rawAction: "BUY BTCUSD NOW SL 80900 TP1 81400",
    ...overrides,
  }
}

function seriesAround(mid: number, fromMs: number): { ts: number; bid: number; ask: number; mid: number }[] {
  const pts = []
  for (let i = 0; i < 10; i++) {
    const px = mid + i
    pts.push({ ts: fromMs + i * 60_000, bid: px - 0.5, ask: px + 0.5, mid: px })
  }
  return pts
}

Deno.test("market_data_mismatch: BTCAUD-scale prices never simulate a USD signal", () => {
  const signal = btcLikeSignal()
  const series = seriesAround(114_140, signal.signalAt.getTime())
  const result = simulateTradeOnSeries(signal, series, strategy, 0.01)
  assertEquals(result.outcome, "market_data_mismatch")
  assertEquals(result.details.marketEntry, true)
  assertEquals(result.details.marketPrice, 114_140.5)
  const minGapPct = result.details.minGapPct as number
  assertEquals(minGapPct > MARKET_DATA_MAX_GAP * 100, true)
})

Deno.test("market_data_mismatch: a price within range simulates normally", () => {
  const signal = btcLikeSignal()
  const series = seriesAround(81_000, signal.signalAt.getTime())
  const result = simulateTradeOnSeries(signal, series, strategy, 0.01)
  assertEquals(result.outcome === "market_data_mismatch", false)
})

Deno.test("market_data_mismatch: a stated entry price far from market is also rejected", () => {
  const signal = btcLikeSignal({ entryPrice: 80_500, sl: 79_200, tpLevels: [83_800] })
  const series = seriesAround(114_140, signal.signalAt.getTime())
  const result = simulateTradeOnSeries(signal, series, strategy, 0.01)
  assertEquals(result.outcome, "market_data_mismatch")
})

Deno.test("market_data_mismatch: guard is skipped when the signal carries no levels", () => {
  const signal = btcLikeSignal({ entryPrice: 0, sl: null, tpLevels: [] })
  const series = seriesAround(114_140, signal.signalAt.getTime())
  const result = simulateTradeOnSeries(signal, series, strategy, 0.01)
  assertEquals(result.outcome === "market_data_mismatch", false)
  assertEquals(result.outcome, "skipped")
})
