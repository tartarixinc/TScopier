/** Parse FxSocket WebSocket `account` topic payloads (camelCase or PascalCase). */
import { effectiveBrokerBalance } from './effectiveBrokerBalance'

export interface FxsocketAccountStreamSnapshot {
  balance?: number
  equity?: number
  openPnl?: number
  /** Whether openPnl came from the broker profit field vs equity − balance. */
  openPnlSource?: 'explicit' | 'derived'
  currency?: string
}

function readNum(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function readStr(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s.length > 0 ? s : undefined
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

export function parseFxsocketAccountStreamData(raw: Record<string, unknown>): FxsocketAccountStreamSnapshot {
  const rawBalance = readNum(raw.balance ?? raw.Balance)
  const credit = readNum(raw.credit ?? raw.Credit)
  const balance = effectiveBrokerBalance(rawBalance, credit) ?? undefined
  const equity = readNum(raw.equity ?? raw.Equity)
  const explicitProfit = readProfitField(raw)
  let openPnl: number | undefined
  let openPnlSource: 'explicit' | 'derived' | undefined
  if (explicitProfit != null) {
    openPnl = explicitProfit
    openPnlSource = 'explicit'
  } else if (balance != null && equity != null) {
    openPnl = equity - balance
    openPnlSource = 'derived'
  }
  return {
    balance,
    equity: equity ?? balance,
    openPnl,
    openPnlSource,
    currency: readStr(raw.currency ?? raw.Currency),
  }
}

/**
 * Account-stream P/L can report 0 while positions still carry floating P/L.
 * Prefer positions-derived values when we already know the account has open legs.
 */
export function shouldApplyAccountStreamOpenPnl(
  snap: FxsocketAccountStreamSnapshot,
  openTrades: number,
): boolean {
  if (snap.openPnl == null || snap.openPnlSource == null) return false
  if (openTrades <= 0) return true
  if (snap.openPnlSource === 'explicit' && Math.abs(snap.openPnl) > 0.001) return true
  if (snap.openPnlSource === 'derived' && Math.abs(snap.openPnl) > 0.001) return true
  return false
}

/** Best floating P/L from account summary / WS account topic (profit or equity − balance). */
export function resolveFxsocketFloatingOpenPnl(
  snap: FxsocketAccountStreamSnapshot,
  openTrades = 0,
): number | undefined {
  if (shouldApplyAccountStreamOpenPnl(snap, openTrades) && snap.openPnl != null) {
    return snap.openPnl
  }
  if (snap.balance != null && snap.equity != null) {
    return Math.round((snap.equity - snap.balance) * 100) / 100
  }
  return undefined
}

export interface FxsocketPositionsStreamSnapshot {
  openTrades: number
  openPnl?: number
}

function readPositionLegPnl(o: Record<string, unknown>): number | null {
  const profit = readProfitField(o)
  const swap = readNum(o.swap ?? o.Swap)
  const commission = readNum(o.commission ?? o.Commission)
  if (profit == null && swap == null && commission == null) return null
  return (profit ?? 0) + (swap ?? 0) + (commission ?? 0)
}

/** FxSocket WS `positions` payloads are usually an array; unwrap common envelopes. */
export function unwrapFxsocketPositionsPayload(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  const o = readRecord(data)
  if (!o) return []
  for (const key of ['positions', 'Positions', 'orders', 'Orders', 'items', 'data', 'Data']) {
    const v = o[key]
    if (Array.isArray(v)) return v
  }
  if (isFxsocketMarketPositionRow(o)) return [o]
  return []
}

/** Open market position count + floating P/L from the WebSocket `positions` topic. */
export function parseFxsocketPositionsStreamData(data: unknown): FxsocketPositionsStreamSnapshot {
  const rows = unwrapFxsocketPositionsPayload(data)
  if (rows.length === 0) {
    return Array.isArray(data) || readRecord(data) ? { openTrades: 0, openPnl: 0 } : { openTrades: 0 }
  }

  let openTrades = 0
  let openPnl = 0
  let hasLegPnl = false

  for (const raw of rows) {
    if (!isFxsocketMarketPositionRow(raw)) continue
    openTrades += 1
    const o = readRecord(raw)
    if (!o) continue
    const legPnl = readPositionLegPnl(o)
    if (legPnl != null) {
      openPnl += legPnl
      hasLegPnl = true
    }
  }

  if (openTrades === 0) {
    return { openTrades: 0, openPnl: 0 }
  }

  return {
    openTrades,
    ...(hasLegPnl ? { openPnl: Math.round(openPnl * 100) / 100 } : {}),
  }
}

function readRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function rawOrderOperation(o: Record<string, unknown>): string {
  return String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '').toLowerCase()
}

function rawNumericOrderKind(o: Record<string, unknown>): number | undefined {
  const pick = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return undefined
  }
  return pick(o.type ?? o.Type ?? o.orderType ?? o.OrderType ?? o.cmd ?? o.Cmd)
}

/** True for resting stop/limit rows (not filled market positions). */
export function isFxsocketPendingOrderRow(raw: unknown): boolean {
  const o = readRecord(raw)
  if (!o) return false
  const kind = String(o.kind ?? o.Kind ?? '').toLowerCase()
  if (kind === 'pending' || kind === 'order') return true
  if (kind === 'position' || kind === 'deal') return false
  const op = rawOrderOperation(o)
  if (op.includes('limit') || op.includes('stop')) return true
  const ot = String(o.orderType ?? o.OrderType ?? '').toLowerCase()
  if (ot.includes('limit') || ot.includes('stop')) return true
  const t = rawNumericOrderKind(o)
  if (t != null && t >= 2 && t <= 5) return true
  if (o.pending === true || o.isPending === true) return true
  const st = String(o.state ?? o.State ?? '').toLowerCase()
  if (st === 'placed') return true
  return false
}

/** True for executed market positions in FxSocket order/position payloads. */
export function isFxsocketMarketPositionRow(raw: unknown): boolean {
  const o = readRecord(raw)
  if (!o) return false
  if (isFxsocketPendingOrderRow(o)) return false
  const kind = String(o.kind ?? o.Kind ?? '').toLowerCase()
  if (kind === 'position' || kind === 'deal') return true
  const op = rawOrderOperation(o).replace(/\s+/g, '')
  if (op === 'buy' || op === 'sell') return true
  const t = rawNumericOrderKind(o)
  if (t === 0 || t === 1) return true
  const symbol = String(o.symbol ?? o.Symbol ?? '').trim()
  const lots = readNum(o.lots ?? o.Lots ?? o.volume ?? o.Volume ?? o.lot_size)
  if (symbol && lots != null && lots > 0 && readPositionLegPnl(o) != null) return true
  return false
}

/** Count open market positions from the WebSocket `positions` topic snapshot. */
export function parseFxsocketOpenPositionCount(data: unknown): number {
  return parseFxsocketPositionsStreamData(data).openTrades
}

/** Pending stop/limit rows from normalized MtTrade / OpenedOrders payloads. */
export function isMtTradePendingEntry(trade: { type?: string | null }): boolean {
  const type = String(trade.type ?? '').toLowerCase()
  return type.includes('limit') || type.includes('stop')
}

export function countOpenMarketPositionsByBroker(
  trades: Array<{ broker_id: string; status?: string; type?: string | null }>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of trades) {
    if (t.status !== 'open') continue
    if (isMtTradePendingEntry(t)) continue
    out[t.broker_id] = (out[t.broker_id] ?? 0) + 1
  }
  return out
}

/** Sum floating P/L on open market legs per broker (REST bootstrap / WS fallback). */
export function sumOpenPnlByBroker(
  trades: Array<{
    broker_id: string
    status?: string
    type?: string | null
    profit?: number | null
    swap?: number | null
    commission?: number | null
  }>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of trades) {
    if (t.status !== 'open') continue
    if (isMtTradePendingEntry(t)) continue
    const profit = t.profit
    if (profit == null || !Number.isFinite(profit)) continue
    const swap = typeof t.swap === 'number' && Number.isFinite(t.swap) ? t.swap : 0
    const commission = typeof t.commission === 'number' && Number.isFinite(t.commission) ? t.commission : 0
    out[t.broker_id] = (out[t.broker_id] ?? 0) + profit + swap + commission
  }
  for (const brokerId of Object.keys(out)) {
    out[brokerId] = Math.round(out[brokerId]! * 100) / 100
  }
  return out
}
