import type { BacktestTimeframe } from "./types.ts"

/** Coarser bars for longer ranges — fewer Massive pages and faster simulation. */
export function effectiveTimeframeForRange(
  dateFrom: string,
  dateTo: string,
  preferred?: BacktestTimeframe,
): BacktestTimeframe {
  const fromMs = new Date(dateFrom).getTime()
  const toMs = new Date(dateTo + "T23:59:59.999Z").getTime()
  const days = Math.max(1, (toMs - fromMs) / 86_400_000)

  if (preferred === "1d") return "1d"
  if (preferred === "1h" && days <= 180) return "1h"
  if (preferred === "15m" && days <= 90) return "15m"
  if (preferred === "5m" && days <= 45) return "5m"
  if (preferred === "1m" && days <= 7) return "1m"

  if (days <= 7) return preferred === "1h" ? "1h" : "5m"
  if (days <= 45) return "5m"
  if (days <= 120) return "15m"
  return "1h"
}
