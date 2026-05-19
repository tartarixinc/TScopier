import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { normalizeSymbolFilter } from "./symbols.ts"
import type { ParsedSignalForBacktest } from "./types.ts"

export interface LoadedSignalsResult {
  signals: ParsedSignalForBacktest[]
  source: "backtest_channel_signals"
  rawParsedCount: number
}

/** Distinct symbols present in backtest_channel_signals for the range (any row). */
export async function listBacktestSymbolsInRange(
  supabase: SupabaseClient,
  userId: string,
  channelIds: string[],
  fromIso: string,
  toIso: string,
): Promise<string[]> {
  if (channelIds.length === 0) return []

  const { data, error } = await supabase
    .from("backtest_channel_signals")
    .select("symbol")
    .eq("user_id", userId)
    .in("channel_id", channelIds)
    .gte("signal_at", fromIso)
    .lte("signal_at", toIso)

  if (error) throw new Error(error.message)

  const out = new Set<string>()
  for (const row of data ?? []) {
    const s = String((row as { symbol?: string }).symbol ?? "").trim().toUpperCase()
    if (s) out.add(s)
  }
  return [...out].sort()
}

/** Load tradeable signals for simulation — backtest table only (never copier `signals`). */
export async function loadBacktestSignals(
  supabase: SupabaseClient,
  userId: string,
  channelIds: string[],
  fromIso: string,
  toIso: string,
  channelNames: Map<string, string>,
  symbolFilter?: string[],
): Promise<LoadedSignalsResult> {
  const filter = normalizeSymbolFilter(symbolFilter ?? [])

  let query = supabase
    .from("backtest_channel_signals")
    .select(
      "id, signal_id, channel_id, signal_at, direction, symbol, entry_price, sl, tp_levels, lot_size",
    )
    .eq("user_id", userId)
    .in("channel_id", channelIds.length ? channelIds : ["00000000-0000-0000-0000-000000000000"])
    .gte("signal_at", fromIso)
    .lte("signal_at", toIso)

  const { data: tradeRows, error: tradeErr } = await query.order("signal_at", { ascending: true })

  if (tradeErr) throw new Error(tradeErr.message)

  const filteredRows = filter.length > 0
    ? (tradeRows ?? []).filter((row) =>
      filter.includes(String((row as { symbol?: string }).symbol ?? "").trim().toUpperCase())
    )
    : (tradeRows ?? [])

  const signals = filteredRows.map((row) =>
    rowToParsed(row as Record<string, unknown>, channelNames)
  ).filter((s): s is ParsedSignalForBacktest => s != null)

  return {
    signals,
    source: "backtest_channel_signals",
    rawParsedCount: tradeRows?.length ?? 0,
  }
}

function rowToParsed(
  row: Record<string, unknown>,
  channelNames: Map<string, string>,
): ParsedSignalForBacktest | null {
  const direction = String(row.direction ?? "").toLowerCase()
  if (direction !== "buy" && direction !== "sell") return null
  const symbol = String(row.symbol ?? "").trim().toUpperCase()
  if (!symbol) return null
  const entry = Number(row.entry_price)
  if (!Number.isFinite(entry) || entry < 0) return null
  const channelId = String(row.channel_id ?? "")
  const rowId = String(row.id ?? "")
  if (!channelId || !rowId) return null

  const tpRaw = row.tp_levels
  const tpLevels = Array.isArray(tpRaw)
    ? tpRaw.map((v) => Number(v)).filter((n) => Number.isFinite(n))
    : []

  const sl = row.sl == null ? null : Number(row.sl)
  if (sl != null && !Number.isFinite(sl)) return null
  if (sl == null && tpLevels.length === 0) return null

  const lot = row.lot_size == null ? null : Number(row.lot_size)
  const signalAt = new Date(String(row.signal_at))

  const copierSignalId = row.signal_id != null && String(row.signal_id).length > 0
    ? String(row.signal_id)
    : null

  return {
    signalId: rowId,
    copierSignalId,
    channelId,
    channelName: channelNames.get(channelId) ?? "Channel",
    signalAt,
    symbol,
    direction: direction as "buy" | "sell",
    entryPrice: entry,
    sl,
    tpLevels,
    lotSize: lot != null && Number.isFinite(lot) ? lot : null,
    rawAction: direction,
  }
}
