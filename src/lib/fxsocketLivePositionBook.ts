import {
  isFxsocketMarketPositionRow,
  isFxsocketPendingOrderRow,
  parseFxsocketPositionsStreamData,
  type FxsocketPositionsStreamSnapshot,
  unwrapFxsocketPositionsPayload,
} from './fxsocketStreamParse'

function readNum(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function readRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function readTicket(o: Record<string, unknown>): number | null {
  for (const key of ['ticket', 'Ticket', 'id', 'Id', 'positionId', 'PositionId']) {
    const n = readNum(o[key])
    if (n != null) return n
  }
  return null
}

function readProfitField(o: Record<string, unknown>): number | undefined {
  for (const key of [
    'profit', 'Profit',
    'floatingProfit', 'FloatingProfit',
    'unrealizedProfit', 'UnrealizedProfit',
    'dealProfit', 'DealProfit',
    'grossProfit', 'GrossProfit',
    'freeProfit', 'FreeProfit',
  ]) {
    const n = readNum(o[key])
    if (n != null) return n
  }
  return undefined
}

function readPositionLegPnl(o: Record<string, unknown>): number | null {
  const profit = readProfitField(o)
  const swap = readNum(o.swap ?? o.Swap)
  const commission = readNum(o.commission ?? o.Commission)
  if (profit == null && swap == null && commission == null) return null
  return (profit ?? 0) + (swap ?? 0) + (commission ?? 0)
}

function isClosedPositionRow(o: Record<string, unknown>): boolean {
  const state = String(o.state ?? o.State ?? '').toLowerCase()
  if (state.includes('closed') || state.includes('cancel') || state.includes('deleted')) return true
  const volume = readNum(o.volume ?? o.Volume ?? o.lots ?? o.Lots)
  if (volume === 0) return true
  return false
}

/** ticket → leg P/L (profit + swap + commission) */
export type FxsocketPositionBook = Map<number, number>

export function rebuildPositionBookFromPayload(data: unknown): FxsocketPositionBook {
  const book: FxsocketPositionBook = new Map()
  for (const raw of unwrapFxsocketPositionsPayload(data)) {
    mergePositionRowIntoBook(book, raw)
  }
  return book
}

/** Apply one WS `trade` or position row; returns true when the book changed. */
export function mergePositionRowIntoBook(book: FxsocketPositionBook, raw: unknown): boolean {
  const o = readRecord(raw)
  if (!o) return false
  const ticket = readTicket(o)
  if (ticket == null) return false

  if (isFxsocketPendingOrderRow(o)) return false

  if (isClosedPositionRow(o) || !isFxsocketMarketPositionRow(o)) {
    if (book.has(ticket)) {
      book.delete(ticket)
      return true
    }
    return false
  }

  const legPnl = readPositionLegPnl(o)
  if (legPnl == null) return false

  const prev = book.get(ticket)
  const rounded = Math.round(legPnl * 100) / 100
  if (prev === rounded) return false
  book.set(ticket, rounded)
  return true
}

export function snapshotFromPositionBook(book: FxsocketPositionBook): FxsocketPositionsStreamSnapshot {
  if (book.size === 0) {
    return { openTrades: 0, openPnl: 0 }
  }
  let openPnl = 0
  for (const leg of book.values()) openPnl += leg
  return {
    openTrades: book.size,
    openPnl: Math.round(openPnl * 100) / 100,
  }
}

export function parseLivePositionsUpdate(data: unknown): FxsocketPositionsStreamSnapshot {
  return parseFxsocketPositionsStreamData(data)
}

/** Bootstrap the live book from REST open legs until trade ticks arrive. */
export function rebuildPositionBookFromMtTrades(
  trades: Array<{
    broker_id: string
    ticket: number
    status: string
    profit: number | null
    swap: number | null
    commission: number | null
  }>,
  brokerId: string,
): FxsocketPositionBook {
  const book: FxsocketPositionBook = new Map()
  for (const trade of trades) {
    if (trade.broker_id !== brokerId || trade.status !== 'open') continue
    const legPnl = (trade.profit ?? 0) + (trade.swap ?? 0) + (trade.commission ?? 0)
    book.set(trade.ticket, Math.round(legPnl * 100) / 100)
  }
  return book
}
