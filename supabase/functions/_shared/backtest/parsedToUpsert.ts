/** Map parse-signal JSON into backtest_channel_signals upsert fields. */
export function tradeableFromParsed(parsed: Record<string, unknown>): {
  direction: "buy" | "sell"
  symbol: string
  entry_price: number
  sl: number | null
  tp_levels: number[]
  lot_size: number | null
} | null {
  const action = String(parsed.action ?? "").toLowerCase()
  if (action !== "buy" && action !== "sell") return null

  const symbol = String(parsed.symbol ?? "").trim().toUpperCase()
  if (!symbol) return null

  const entry = num(parsed.entry_price) ?? num(parsed.entry_zone_low) ?? num(parsed.entry_zone_high)
  if (entry == null || entry <= 0) return null

  const sl = num(parsed.sl)
  const tpRaw = parsed.tp
  const tp_levels: number[] = Array.isArray(tpRaw)
    ? tpRaw.map((v) => num(v)).filter((n): n is number => n != null)
    : []

  if (sl == null && tp_levels.length === 0) return null

  const lot = num(parsed.lot_size)

  return {
    direction: action as "buy" | "sell",
    symbol,
    entry_price: entry,
    sl,
    tp_levels,
    lot_size: lot,
  }
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
