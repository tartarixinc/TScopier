import type { MtTrade } from './fxsocketBroker'
import {
  isFxsocketMarketPositionRow,
  isFxsocketPendingOrderRow,
} from './fxsocketStreamParse'
import type { BrokerAccount } from '../types/database'

function readRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function readNum(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function readString(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function readTicket(o: Record<string, unknown>): number | null {
  for (const key of ['ticket', 'Ticket', 'id', 'Id', 'positionId', 'PositionId']) {
    const n = readNum(o[key])
    if (n != null) return n
  }
  return null
}

function resolveDirectionFromRow(o: Record<string, unknown>): 'buy' | 'sell' | '' {
  const type = readString(o, 'type', 'Type', 'orderType', 'OrderType') ?? ''
  const lower = type.toLowerCase()
  if (lower.startsWith('buy') || lower.includes('buy')) return 'buy'
  if (lower.startsWith('sell') || lower.includes('sell')) return 'sell'
  return ''
}

function readLegPnl(o: Record<string, unknown>): number {
  const profit = readNum(o.profit ?? o.Profit ?? o.floatingProfit ?? o.FloatingProfit) ?? 0
  const swap = readNum(o.swap ?? o.Swap) ?? 0
  const commission = readNum(o.commission ?? o.Commission) ?? 0
  return Math.round((profit + swap + commission) * 100) / 100
}

function mtTradeFromPositionRow(
  account: BrokerAccount,
  o: Record<string, unknown>,
): MtTrade | null {
  if (isFxsocketPendingOrderRow(o) || !isFxsocketMarketPositionRow(o)) return null
  const ticket = readTicket(o)
  const symbol = readString(o, 'symbol', 'Symbol') ?? ''
  const lotSize = readNum(o.lots ?? o.Lots ?? o.volume ?? o.Volume ?? o.lot ?? o.Lot) ?? 0
  const direction = resolveDirectionFromRow(o)
  if (ticket == null || !symbol || lotSize <= 0 || !direction) return null

  const type = readString(o, 'type', 'Type') ?? (direction === 'buy' ? 'Buy' : 'Sell')
  const legPnl = readLegPnl(o)

  return {
    id: `${account.id}:${ticket}`,
    broker_id: account.id,
    broker_label: account.label?.trim() || account.broker_name?.trim() || 'Account',
    broker_name: account.broker_name ?? null,
    ticket,
    symbol,
    direction,
    type,
    lot_size: lotSize,
    entry_price: readNum(o.openPrice ?? o.OpenPrice ?? o.price ?? o.Price) ?? null,
    sl: readNum(o.stopLoss ?? o.StopLoss ?? o.sl ?? o.SL) ?? null,
    tp: readNum(o.takeProfit ?? o.TakeProfit ?? o.tp ?? o.TP) ?? null,
    close_price: null,
    profit: legPnl,
    swap: readNum(o.swap ?? o.Swap) ?? 0,
    commission: readNum(o.commission ?? o.Commission) ?? 0,
    comment: readString(o, 'comment', 'Comment'),
    magic: readNum(o.magic ?? o.Magic ?? o.magicNumber ?? o.MagicNumber) ?? null,
    opened_at: readString(o, 'openTime', 'OpenTime', 'open_time', 'timeOpen', 'TimeOpen', 'time', 'Time'),
    closed_at: null,
    state: readString(o, 'state', 'State'),
    status: 'open',
  }
}

/** Merge live WS position rows into REST mtTrades (P/L, comment, missing open legs). */
export function mergeLivePositionsIntoMtTrades(
  trades: MtTrade[],
  account: BrokerAccount,
  positionRows: Iterable<unknown>,
): MtTrade[] {
  const brokerId = account.id
  const indexByTicket = new Map<number, number>()
  const out = [...trades]

  for (let i = 0; i < out.length; i++) {
    const trade = out[i]!
    if (trade.broker_id === brokerId) indexByTicket.set(trade.ticket, i)
  }

  let changed = false
  for (const raw of positionRows) {
    const o = readRecord(raw)
    if (!o) continue
    const ticket = readTicket(o)
    if (ticket == null) continue

    const legPnl = readLegPnl(o)
    const comment = readString(o, 'comment', 'Comment')
    const existingIdx = indexByTicket.get(ticket)

    if (existingIdx != null) {
      const existing = out[existingIdx]!
      if (existing.status !== 'open') continue
      const openTime =
        readString(o, 'openTime', 'OpenTime', 'open_time', 'timeOpen', 'TimeOpen', 'time', 'Time') ??
        existing.opened_at
      const nextComment = comment ?? existing.comment
      if (
        legPnl === existing.profit &&
        nextComment === existing.comment &&
        openTime === existing.opened_at
      ) {
        continue
      }
      out[existingIdx] = { ...existing, profit: legPnl, comment: nextComment, opened_at: openTime }
      changed = true
      continue
    }

    const synthetic = mtTradeFromPositionRow(account, o)
    if (!synthetic) continue
    indexByTicket.set(ticket, out.length)
    out.push(synthetic)
    changed = true
  }

  return changed ? out : trades
}
