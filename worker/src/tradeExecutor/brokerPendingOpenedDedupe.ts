import { isPendingEntryRow, rawOrderOperation, rawNumericOrderKind } from '../signalEntryPendingHelpers'

function readNumber(row: unknown, ...keys: string[]): number | null {
  if (row == null || typeof row !== 'object') return null
  const o = row as Record<string, unknown>
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

function readString(row: unknown, ...keys: string[]): string | null {
  if (row == null || typeof row !== 'object') return null
  const o = row as Record<string, unknown>
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function isSideLimit(row: unknown, side: 'buy' | 'sell'): boolean {
  const o = row as Record<string, unknown>
  const op = (rawOrderOperation(o) || readString(row, 'orderType', 'OrderType') || '')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase()
  const kind = rawNumericOrderKind(o)
  if (side === 'buy') {
    return op.includes('buylimit') || kind === 2
  }
  return op.includes('selllimit') || kind === 3
}

/**
 * Price keys (fixed to `digits`) for resting BuyLimit/SellLimit orders already
 * on the broker for `symbol`. Used to skip duplicate OrderSends when rematerialize
 * races or DB rows are missing.
 */
export function brokerLimitPriceKeysFromOpenedOrders(args: {
  openedOrders: readonly unknown[]
  symbol: string
  side: 'buy' | 'sell'
  digits: number
  /** When set, only adopt limits whose comment contains this (signal id / UniCopier prefix). */
  commentNeedle?: string | null
}): Set<string> {
  const sym = args.symbol.toUpperCase()
  const needle = args.commentNeedle?.trim() || null
  const out = new Set<string>()
  for (const row of args.openedOrders) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    if (!isPendingEntryRow(o)) continue
    const rowSym = readString(row, 'symbol', 'Symbol')?.toUpperCase()
    if (rowSym && rowSym !== sym) continue
    if (!isSideLimit(row, args.side)) continue
    if (needle) {
      const comment = readString(row, 'comment', 'Comment') ?? ''
      if (!comment.includes(needle)) continue
    }
    const price = readNumber(row, 'openPrice', 'OpenPrice', 'price', 'Price', 'priceOpen', 'PriceOpen')
    if (price == null || !(price > 0)) continue
    out.add(Number(price).toFixed(args.digits))
  }
  return out
}
