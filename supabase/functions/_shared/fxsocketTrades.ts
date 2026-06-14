import type { FxsocketClient } from "./fxsocketClient.ts"
import {
  adjustMtTradesPositionDirection,
  flattenMtOrder,
  ingestMtHistoryRows,
  pickMtField,
  reconcileTradeDirectionWithStops,
  resolveMtCloseTimestamp,
  resolveMtDealProfit,
  resolveMtLots,
  resolveMtLiveOpenTimestamp,
  resolveMtOpenTimestamp,
  resolveMtPositionTicket,
  resolveMtTicket,
  type MtHistoryProfile,
  type RawMtOrder,
} from "./mtTradeFields.ts"

type RawOrder = Record<string, unknown>

export interface FxsocketBrokerTradeRow {
  id: string
  broker_id: string
  broker_label: string
  broker_name: string | null
  ticket: number
  position_ticket?: number | null
  symbol: string
  direction: "buy" | "sell" | ""
  type: string
  lot_size: number
  entry_price: number | null
  sl: number | null
  tp: number | null
  close_price: number | null
  profit: number | null
  swap: number | null
  commission: number | null
  comment: string | null
  magic: number | null
  opened_at: string | null
  closed_at: string | null
  state: string | null
  status: "open" | "closed"
}

type BrokerRow = {
  id: string
  label: string
  broker_name: string | null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const codeMapMt5: Record<number, { direction: "buy" | "sell" | ""; label: string }> = {
  0: { direction: "buy", label: "Buy" },
  1: { direction: "sell", label: "Sell" },
  2: { direction: "buy", label: "Buy Limit" },
  3: { direction: "sell", label: "Sell Limit" },
  4: { direction: "buy", label: "Buy Stop" },
  5: { direction: "sell", label: "Sell Stop" },
  6: { direction: "buy", label: "Buy Stop Limit" },
  7: { direction: "sell", label: "Sell Stop Limit" },
  8: { direction: "", label: "Close By" },
}

function resolveDirection(order: RawOrder, historyProfile: MtHistoryProfile): { direction: "buy" | "sell" | ""; type_label: string } {
  const pick = (...keys: string[]) => pickMtField(order, historyProfile, ...keys)
  const stringCandidate = pick("type", "Type", "orderType", "OrderType", "dealType", "DealType")
  if (typeof stringCandidate === "string" && stringCandidate.trim()) {
    const cleaned = stringCandidate.replace(/^(OrderType_|DealType_|DEAL_TYPE_|ORDER_TYPE_|POSITION_TYPE_|PositionType_)/i, "").trim()
    const lower = cleaned.toLowerCase()
    const direction: "buy" | "sell" | "" =
      lower.startsWith("buy") ? "buy"
      : lower.startsWith("sell") ? "sell"
      : lower.includes("buy") ? "buy"
      : lower.includes("sell") ? "sell"
      : ""
    const label = cleaned.replace(/([a-z])([A-Z])/g, "$1 $2")
    if (direction || label) return { direction, type_label: label || cleaned }
  }
  const numericCandidate = pick("type", "Type", "orderType", "OrderType", "dealType", "DealType", "cmd", "Cmd")
  if (typeof numericCandidate === "number" && codeMapMt5[numericCandidate]) {
    const m = codeMapMt5[numericCandidate]
    return { direction: m.direction, type_label: m.label }
  }
  return { direction: "", type_label: "" }
}

function isBalanceOpType(typeLabel: string): boolean {
  const type = typeLabel.toLowerCase()
  return (
    type.includes("balance") ||
    type.includes("credit") ||
    type.includes("deposit") ||
    type.includes("withdraw") ||
    type.includes("correction") ||
    type.includes("transfer")
  )
}

function isNonTradeEntry(direction: string, typeLabel: string, lotSize: number): boolean {
  if (isBalanceOpType(typeLabel)) return true
  return direction === "" && lotSize <= 0
}

function normalizeOrder(
  order: RawOrder,
  broker: BrokerRow,
  status: "open" | "closed",
  historyProfile: MtHistoryProfile,
): FxsocketBrokerTradeRow {
  const row = historyProfile === "trades" ? flattenMtOrder(order, "trades") : order
  const ticket = resolveMtTicket(row, historyProfile)
  const positionTicket = historyProfile === "trades" ? resolveMtPositionTicket(order, "trades") : null
  const resolved = resolveDirection(row, historyProfile)
  const adjusted =
    status === "closed" && historyProfile === "trades"
      ? adjustMtTradesPositionDirection(order, historyProfile, resolved)
      : resolved
  const lot_size = resolveMtLots(
    historyProfile === "trades" ? (order as RawMtOrder) : row,
    historyProfile,
  )
  const entry_price = num(pickMtField(row, historyProfile, "openPrice", "OpenPrice", "price"))
  const sl = num(pickMtField(row, historyProfile, "stopLoss", "StopLoss", "sl"))
  const tp = num(pickMtField(row, historyProfile, "takeProfit", "TakeProfit", "tp"))
  const { direction, type_label } = reconcileTradeDirectionWithStops(
    adjusted.direction,
    entry_price,
    sl,
    tp,
  )
  const openTime = status === "open"
    ? resolveMtLiveOpenTimestamp(order, historyProfile)
    : resolveMtOpenTimestamp(order, historyProfile)
  const closeTime = resolveMtCloseTimestamp(order, historyProfile)
  return {
    id: `${broker.id}:${ticket}`,
    broker_id: broker.id,
    broker_label: broker.label,
    broker_name: broker.broker_name,
    ticket,
    position_ticket: positionTicket,
    symbol: String(pickMtField(row, historyProfile, "symbol", "Symbol") ?? ""),
    direction,
    type: type_label,
    lot_size,
    entry_price,
    sl,
    tp,
    close_price: num(pickMtField(row, historyProfile, "closePrice", "ClosePrice")),
    profit: isNonTradeEntry(direction, type_label, lot_size) && !isBalanceOpType(type_label)
      ? null
      : resolveMtDealProfit(row, historyProfile),
    swap: num(pickMtField(row, historyProfile, "swap", "Swap")),
    commission: num(pickMtField(row, historyProfile, "commission", "Commission")),
    comment: (pickMtField(row, historyProfile, "comment", "Comment") as string | undefined) ?? null,
    magic: num(pickMtField(row, historyProfile, "magicNumber", "MagicNumber", "magic", "Magic")),
    opened_at: openTime,
    closed_at: closeTime,
    state: (pickMtField(row, historyProfile, "state", "State") as string | undefined) ?? null,
    status,
  }
}

export async function fetchFxsocketBrokerTrades(
  fx: FxsocketClient,
  broker: BrokerRow & { fxsocket_account_id: string },
  opts: {
    scope: string
    historyFrom: string
    historyTo: string
    historyProfile: MtHistoryProfile
    limit: number
  },
): Promise<FxsocketBrokerTradeRow[]> {
  const sessionId = String(broker.fxsocket_account_id ?? "").trim()
  if (!sessionId) return []

  const wantOpen = opts.scope === "all" || opts.scope === "open"
  const wantClosed = opts.scope === "all" || opts.scope === "closed"

  const [openedRes, closedRes] = await Promise.allSettled([
    wantOpen ? fx.openedOrders(sessionId) : Promise.resolve([] as unknown[]),
    wantClosed
      ? opts.historyProfile === "trades"
        ? fetchTradesListFromPositionHistory(fx, broker, {
          historyFrom: opts.historyFrom,
          historyTo: opts.historyTo,
        })
        : fetchClosedHistoryForBaseline(fx, broker, {
          historyFrom: opts.historyFrom,
          historyTo: opts.historyTo,
          historyProfile: opts.historyProfile,
        })
      : Promise.resolve([] as FxsocketBrokerTradeRow[]),
  ])

  const out: FxsocketBrokerTradeRow[] = []
  if (openedRes.status === "fulfilled" && Array.isArray(openedRes.value)) {
    for (const o of openedRes.value as RawOrder[]) {
      out.push(normalizeOrder(o, broker, "open", opts.historyProfile))
    }
  }
  if (closedRes.status === "fulfilled" && Array.isArray(closedRes.value)) {
    out.push(...closedRes.value)
  }

  return out.sort((a, b) => {
    const at = a.status === "closed" ? (a.closed_at ?? a.opened_at) : a.opened_at
    const bt = b.status === "closed" ? (b.closed_at ?? b.opened_at) : b.opened_at
    const av = at ? Date.parse(at) : 0
    const bv = bt ? Date.parse(bt) : 0
    return bv - av
  }).slice(0, opts.limit > 0 ? opts.limit : undefined)
}

const BASELINE_HISTORY_CHUNK_DAYS = 45
/** PositionHistory date-range chunk size (one API call per chunk). */
const POSITION_HISTORY_CHUNK_DAYS = 365

export const BROKER_FULL_HISTORY_FROM_DATE = "2000-01-01"

function parseHistoryIso(iso: string): Date {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d : new Date()
}

function formatHistoryChunk(d: Date): string {
  return d.toISOString().slice(0, 19)
}

function buildHistoryChunks(fromIso: string, toIso: string): Array<{ from: string; to: string }> {
  const start = parseHistoryIso(fromIso)
  const end = parseHistoryIso(toIso)
  if (end.getTime() <= start.getTime()) {
    return [{ from: fromIso, to: toIso }]
  }

  const chunks: Array<{ from: string; to: string }> = []
  let cursor = new Date(start)
  while (cursor.getTime() < end.getTime()) {
    const chunkEnd = new Date(cursor)
    chunkEnd.setDate(chunkEnd.getDate() + BASELINE_HISTORY_CHUNK_DAYS)
    const boundedEnd = chunkEnd.getTime() > end.getTime() ? end : chunkEnd
    chunks.push({
      from: formatHistoryChunk(cursor),
      to: formatHistoryChunk(boundedEnd),
    })
    cursor = new Date(boundedEnd)
    cursor.setDate(cursor.getDate() + 1)
  }
  return chunks.length > 0 ? chunks : [{ from: fromIso, to: toIso }]
}

function buildPositionHistoryDateChunks(fromIso: string, toIso: string): Array<{ from: string; to: string }> {
  const start = parseHistoryIso(fromIso)
  const end = parseHistoryIso(toIso)
  if (end.getTime() <= start.getTime()) {
    return [{
      from: toBrokerHistoryDateParam(fromIso),
      to: toBrokerHistoryDateParam(toIso),
    }]
  }

  const chunks: Array<{ from: string; to: string }> = []
  let cursor = new Date(start)
  while (cursor.getTime() < end.getTime()) {
    const chunkEnd = new Date(cursor)
    chunkEnd.setDate(chunkEnd.getDate() + POSITION_HISTORY_CHUNK_DAYS)
    const boundedEnd = chunkEnd.getTime() > end.getTime() ? end : chunkEnd
    chunks.push({
      from: toBrokerHistoryDateParam(formatHistoryChunk(cursor)),
      to: toBrokerHistoryDateParam(formatHistoryChunk(boundedEnd)),
    })
    cursor = new Date(boundedEnd)
    cursor.setDate(cursor.getDate() + 1)
  }
  return chunks.length > 0
    ? chunks
    : [{ from: toBrokerHistoryDateParam(fromIso), to: toBrokerHistoryDateParam(toIso) }]
}

function rowCloseMs(row: Pick<FxsocketBrokerTradeRow, "closed_at" | "opened_at">): number {
  const iso = row.closed_at ?? row.opened_at
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

/** Full closed history for baseline inference — chunked OrderHistory + ticket dedupe. */
export async function fetchClosedHistoryForBaseline(
  fx: FxsocketClient,
  broker: BrokerRow & { fxsocket_account_id: string },
  opts: {
    historyFrom: string
    historyTo: string
    historyProfile: MtHistoryProfile
  },
): Promise<FxsocketBrokerTradeRow[]> {
  const sessionId = String(broker.fxsocket_account_id ?? "").trim()
  if (!sessionId) return []

  const merged = new Map<string, RawMtOrder>()
  const chunks = buildHistoryChunks(opts.historyFrom, opts.historyTo)
  const orderSettled = await Promise.allSettled(
    chunks.map(chunk => fx.orderHistory(sessionId, chunk.from, chunk.to)),
  )

  for (const result of orderSettled) {
    if (result.status !== "fulfilled") continue
    ingestMtHistoryRows(merged, result.value, opts.historyProfile)
  }

  const out: FxsocketBrokerTradeRow[] = []
  for (const row of merged.values()) {
    const trade = normalizeOrder(row, broker, "closed", opts.historyProfile)
    if (opts.historyProfile === "trades") {
      if (trade.lot_size <= 0 && !trade.symbol.trim()) continue
      if (isNonTradeEntry(trade.direction, trade.type, trade.lot_size)) continue
    }
    out.push(trade)
  }

  return out.sort((a, b) => {
    const av = rowCloseMs(a)
    const bv = rowCloseMs(b)
    return bv - av
  })
}

function readScalar(row: RawOrder, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k]
    if (v !== undefined && v !== null && v !== "") return v
  }
  return undefined
}

/** YYYY-MM-DD for FxSocket PositionHistory (matches Swagger). */
function toBrokerHistoryDateParam(iso: string): string {
  const trimmed = iso.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  const d = new Date(trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T"))
  if (!Number.isFinite(d.getTime())) return trimmed.slice(0, 10)
  return d.toISOString().slice(0, 10)
}

function directionFromPositionType(typeStr: string): { direction: "buy" | "sell" | ""; type_label: string } {
  const cleaned = typeStr.replace(/^(OrderType_|DealType_|POSITION_TYPE_|PositionType_)/i, "").trim()
  const lower = cleaned.toLowerCase()
  const direction: "buy" | "sell" | "" =
    lower.startsWith("buy") ? "buy"
    : lower.startsWith("sell") ? "sell"
    : lower.includes("buy") ? "buy"
    : lower.includes("sell") ? "sell"
    : ""
  const label = cleaned.replace(/([a-z])([A-Z])/g, "$1 $2").trim()
  return { direction, type_label: label || cleaned || typeStr }
}

/** Map one FxSocket PositionHistory row → closed MtTrade (no merge/flatten). */
export function mapPositionHistoryRow(row: RawOrder, broker: BrokerRow): FxsocketBrokerTradeRow | null {
  const positionId = num(readScalar(row, "positionId", "PositionId", "ticket", "Ticket"))
  if (positionId == null || positionId <= 0) return null

  const symbol = String(readScalar(row, "symbol", "Symbol") ?? "").trim()
  if (!symbol) return null

  const volume = num(readScalar(row, "volume", "Volume", "lots", "Lots"))
  if (volume == null || volume <= 0) return null

  const closedAt = resolveMtCloseTimestamp(row as RawMtOrder, "trades")
  if (!closedAt) return null

  const openedAt = resolveMtOpenTimestamp(row as RawMtOrder, "trades")
  const typeStr = String(readScalar(row, "type", "Type") ?? "")
  const { direction, type_label } = directionFromPositionType(typeStr)
  if (isNonTradeEntry(direction, type_label, volume)) return null

  const netProfit = num(readScalar(row, "netProfit", "NetProfit"))
  const profit = num(readScalar(row, "profit", "Profit"))

  return {
    id: `${broker.id}:${positionId}`,
    broker_id: broker.id,
    broker_label: broker.label,
    broker_name: broker.broker_name,
    ticket: positionId,
    position_ticket: positionId,
    symbol,
    direction,
    type: type_label,
    lot_size: volume,
    entry_price: num(readScalar(row, "openPrice", "OpenPrice")),
    sl: null,
    tp: null,
    close_price: num(readScalar(row, "closePrice", "ClosePrice")),
    profit: netProfit ?? profit,
    swap: num(readScalar(row, "swap", "Swap")),
    commission: num(readScalar(row, "commission", "Commission")),
    comment: (readScalar(row, "comment", "Comment") as string | undefined) ?? null,
    magic: num(readScalar(row, "magic", "Magic", "magicNumber", "MagicNumber")),
    opened_at: openedAt,
    closed_at: closedAt,
    state: null,
    status: "closed",
  }
}

/** Trades page closed legs — one row per PositionHistory round-trip. */
export async function fetchTradesListFromPositionHistory(
  fx: FxsocketClient,
  broker: BrokerRow & { fxsocket_account_id: string },
  opts: {
    historyFrom: string
    historyTo: string
  },
): Promise<FxsocketBrokerTradeRow[]> {
  const sessionId = String(broker.fxsocket_account_id ?? "").trim()
  if (!sessionId) return []

  const chunks = buildPositionHistoryDateChunks(opts.historyFrom, opts.historyTo)
  const settled = await Promise.allSettled(
    chunks.map(chunk => fx.positionHistory(sessionId, chunk.from, chunk.to)),
  )

  const seen = new Set<number>()
  const out: FxsocketBrokerTradeRow[] = []
  for (const result of settled) {
    if (result.status !== "fulfilled") continue
    for (const row of result.value) {
      if (!row || typeof row !== "object") continue
      const trade = mapPositionHistoryRow(row as RawOrder, broker)
      if (!trade) continue
      if (seen.has(trade.ticket)) continue
      seen.add(trade.ticket)
      out.push(trade)
    }
  }

  return out.sort((a, b) => rowCloseMs(b) - rowCloseMs(a))
}
