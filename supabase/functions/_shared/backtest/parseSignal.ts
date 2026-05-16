import type { ParsedSignalForBacktest } from "./types.ts"

export function parseSignalRow(row: {
  id: string
  channel_id: string
  created_at: string
  parsed_data: unknown
  status: string
}, channelName: string): ParsedSignalForBacktest | null {
  if (row.status !== "parsed" && row.status !== "executed") return null
  const pd = row.parsed_data as Record<string, unknown> | null
  if (!pd) return null

  const action = String(pd.action ?? "").toLowerCase()
  if (action !== "buy" && action !== "sell") return null

  const symbol = String(pd.symbol ?? "").trim().toUpperCase()
  if (!symbol) return null

  const entry = num(pd.entry_price) ?? num(pd.entry_zone_low) ?? num(pd.entry_zone_high)
  if (entry == null || entry <= 0) return null

  const sl = num(pd.sl)
  const tpRaw = pd.tp
  const tpLevels: number[] = Array.isArray(tpRaw)
    ? tpRaw.map((v) => num(v)).filter((n): n is number => n != null)
    : []

  if (sl == null && tpLevels.length === 0) return null

  return {
    signalId: row.id,
    channelId: row.channel_id,
    channelName,
    signalAt: new Date(row.created_at),
    symbol,
    direction: action as "buy" | "sell",
    entryPrice: entry,
    sl,
    tpLevels,
    lotSize: num(pd.lot_size),
    rawAction: action,
  }
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
