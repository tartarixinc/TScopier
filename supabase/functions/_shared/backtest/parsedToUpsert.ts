import { isTradableInstrumentSymbol, sanitizeParsedSymbol } from "../tradableSymbol.ts"

/** Map parse-signal / AI JSON into backtest_channel_signals upsert fields. */
export function tradeableFromParsed(parsed: Record<string, unknown>): {
  direction: "buy" | "sell"
  symbol: string
  entry_price: number
  sl: number | null
  tp_levels: number[]
  lot_size: number | null
  market_entry: boolean
} | null {
  const action = String(parsed.action ?? "").toLowerCase()
  if (action !== "buy" && action !== "sell") return null

  const symbol = sanitizeParsedSymbol(
    typeof parsed.symbol === "string" ? parsed.symbol : null,
  )
  if (!symbol || !isTradableInstrumentSymbol(symbol)) return null

  const entryExplicit =
    num(parsed.entry_price) ??
    num(parsed.entry_zone_low) ??
    num(parsed.entry_zone_high)

  const sl = num(parsed.sl)
  const tpRaw = parsed.tp
  const tp_levels: number[] = Array.isArray(tpRaw)
    ? tpRaw.map((v) => num(v)).filter((n): n is number => n != null)
    : []

  if (sl == null && tp_levels.length === 0) return null

  const market_entry = entryExplicit == null || entryExplicit <= 0
  const entry_price = market_entry ? 0 : entryExplicit

  const lot = num(parsed.lot_size)

  return {
    direction: action as "buy" | "sell",
    symbol,
    entry_price,
    sl,
    tp_levels,
    lot_size: lot,
    market_entry,
  }
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
