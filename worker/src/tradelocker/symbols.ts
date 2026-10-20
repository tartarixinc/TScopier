/**
 * TradeLocker instrument helpers: symbol matching, lot sizing, idempotency tags, history grouping.
 *
 * Orders carry `qty` in lots. The only caller-chosen identifier an order accepts is `strategyId`
 * (a free string of at most 31 characters, echoed in orders, history and positions), so it is the
 * idempotency tag.
 */
import { floorToStep } from '../bybit/symbols'

export interface TradelockerInstrument {
  tradableInstrumentId: number
  name: string
  tradeRouteId: number | undefined
  infoRouteId: number | undefined
}

export interface TradelockerInstrumentDetails {
  /** Units of the instrument in one lot (contract size). */
  lotSize: number | undefined
  lotStep: number | undefined
  minLot: number | undefined
  maxLot: number | undefined
  tickSize: number | undefined
  quotingCurrency: string | undefined
}

export const STRATEGY_PREFIX = 'TSC'
export const STRATEGY_MAX = 31

export class TradelockerSizingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TradelockerSizingError'
  }
}

export function normalizeSymbolKey(symbol: string): string {
  return String(symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Match a signal symbol (XAUUSD) to a broker symbol (XAU/USD, XAUUSD.x). Exact first, then one suffix away. */
export function matchInstrument<T extends { name: string }>(list: Iterable<T>, wanted: string): T | undefined {
  const key = normalizeSymbolKey(wanted)
  if (!key) return undefined
  const all = [...list]
  const exact = all.find(item => item.name === wanted) ?? all.find(item => normalizeSymbolKey(item.name) === key)
  if (exact) return exact
  return all
    .filter(item => {
      const k = normalizeSymbolKey(item.name)
      return k.startsWith(key) && k.length - key.length <= 4
    })
    .sort((a, b) => a.name.length - b.name.length)[0]
}

function decimalsOf(step: number): number {
  const text = String(step)
  if (text.includes('e-')) return Number(text.split('e-')[1])
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

/**
 * Floor signal lots to the lot step and check the minimum and maximum. Without published limits the
 * step defaults to 0.01 so a quantity never carries float noise.
 */
export function sizeLots(lots: number, symbol: string, details: Pick<TradelockerInstrumentDetails, 'lotStep' | 'minLot' | 'maxLot'>): number {
  if (!(lots > 0)) throw new TradelockerSizingError('Lot size must be above 0')
  const step = details.lotStep && details.lotStep > 0 ? details.lotStep : 0.01
  const qty = floorToStep(Number(lots.toPrecision(12)), step)
  const min = details.minLot && details.minLot > 0 ? details.minLot : step
  if (!(qty > 0) || qty < min - 1e-12) {
    throw new TradelockerSizingError(`${symbol} needs at least ${min} lots (the signal size ${lots} is below it)`)
  }
  if (details.maxLot && details.maxLot > 0 && qty > details.maxLot + 1e-12) {
    throw new TradelockerSizingError(`${symbol} allows at most ${details.maxLot} lots per order`)
  }
  return Number(qty.toFixed(decimalsOf(step)))
}

export function roundToTick(price: number, tickSize: number | undefined): number {
  if (!tickSize || !(tickSize > 0)) return price
  return Number((Math.round(price / tickSize) * tickSize).toFixed(decimalsOf(tickSize)))
}

function fnv(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

/** Signal id head of a copier comment (`TScopier:slug:<signal id>:...`), alphanumerics only. */
export function commentTail(comment: string | undefined): string {
  const parts = String(comment ?? '').split(':').map(part => part.trim()).filter(Boolean)
  const idIndex = parts.findIndex((part, index) => index > 0 && /^[a-f0-9]{8}/i.test(part))
  const tail = idIndex >= 0 ? parts[idIndex]! : ''
  return tail.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
}

/**
 * Entry tag: `TSC.<signal tail>.<fingerprint>.<bucket>`, at most 31 characters.
 * The fingerprint covers symbol, side, size and prices; the bucket spans two minutes, so a retry of the
 * same order maps to the same tag and can be found again by it.
 */
export function entryStrategyId(args: {
  comment?: string
  symbol: string
  operation: string
  qty: number
  price?: number | null
  stopLoss?: number | null
  takeProfit?: number | null
  now: number
}): string {
  const finger = fnv([args.symbol, args.operation, args.qty, args.price ?? '', args.stopLoss ?? '', args.takeProfit ?? ''].join('|')).toString(36).slice(0, 7)
  const bucket = Math.floor(args.now / 120_000).toString(36)
  const tail = commentTail(args.comment)
  const id = tail ? `${STRATEGY_PREFIX}.${tail}.${finger}.${bucket}` : `${STRATEGY_PREFIX}.${finger}.${bucket}`
  return id.slice(0, STRATEGY_MAX)
}

export function isCopierStrategyId(value: unknown): boolean {
  return /^TSC\./.test(String(value ?? ''))
}

/** Readable `TScopier:<tail>` comment from an entry tag (empty when the signal tail is missing). */
export function commentFromStrategyId(value: unknown): string {
  const text = String(value ?? '')
  if (!isCopierStrategyId(text)) return ''
  const parts = text.split('.')
  // TSC.<tail>.<fingerprint>.<bucket> has four parts; without a tail there are three.
  if (parts.length < 4) return ''
  return `TScopier:${parts[1]}`
}

/** Ticket numbers are the broker's numeric ids. Anything else hashes onto a positive 32-bit int. */
export function ticketFromId(id: unknown): number {
  const text = String(id ?? '').trim()
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  return fnv(text) + 1
}

export function sideForOperation(operation: string): 'buy' | 'sell' {
  return /sell/i.test(operation) ? 'sell' : 'buy'
}

export function orderTypeForOperation(operation: string): 'market' | 'limit' | 'stop' {
  if (/limit/i.test(operation)) return 'limit'
  if (/stop/i.test(operation)) return 'stop'
  return 'market'
}

export function oppositeSide(side: string): 'buy' | 'sell' {
  return String(side).toLowerCase() === 'buy' ? 'sell' : 'buy'
}

type Json = Record<string, unknown>

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function timeOf(order: Json): number {
  const direct = finite(order.createdDate)
  if (direct !== undefined) return direct
  const parsed = Date.parse(String(order.createdDate ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function isFilledStatus(status: unknown): boolean {
  return /fill/i.test(String(status ?? ''))
}

export function isRejectedStatus(status: unknown): boolean {
  return /reject|cancel|expire|fail/i.test(String(status ?? ''))
}

export interface ClosedTrade {
  positionId: string
  closeId: string
  symbol: string
  /** Side of the position (the opening order's side). */
  positionSide: 'buy' | 'sell'
  lots: number
  openPrice: number | undefined
  closePrice: number | undefined
  openedAt: number | undefined
  closedAt: number | undefined
  stopLoss: number | undefined
  takeProfit: number | undefined
  strategyId: string
}

/**
 * Closed trades from order history. A position's opening order is the earliest filled order with its
 * positionId; filled orders on the other side with the same positionId are the closes (manual, stop
 * loss or take profit).
 */
export function closedTradesFromHistory(history: Json[], names: Map<number, string>): ClosedTrade[] {
  const filled = history.filter(order =>
    isFilledStatus(order.status)
    && (finite(order.filledQty) ?? finite(order.qty) ?? 0) > 0
    && String(order.positionId ?? '').trim() !== ''
    && String(order.positionId) !== '0',
  )
  const byPosition = new Map<string, Json[]>()
  for (const order of filled) {
    const key = String(order.positionId)
    const list = byPosition.get(key) ?? []
    list.push(order)
    byPosition.set(key, list)
  }
  const out: ClosedTrade[] = []
  for (const [positionId, orders] of byPosition) {
    orders.sort((a, b) => timeOf(a) - timeOf(b) || (finite(a.id) ?? 0) - (finite(b.id) ?? 0))
    const opener = orders[0]!
    const side = String(opener.side ?? '').toLowerCase()
    for (const close of orders.slice(1)) {
      if (String(close.side ?? '').toLowerCase() === side) continue
      const sl = finite(opener.stopLoss)
      const tp = finite(opener.takeProfit)
      out.push({
        positionId,
        closeId: String(close.id ?? ''),
        symbol: names.get(Number(opener.tradableInstrumentId)) ?? String(opener.tradableInstrumentId ?? ''),
        positionSide: side === 'sell' ? 'sell' : 'buy',
        lots: finite(close.filledQty) ?? finite(close.qty) ?? 0,
        openPrice: finite(opener.avgPrice) || undefined,
        closePrice: finite(close.avgPrice) || undefined,
        openedAt: timeOf(opener) || undefined,
        closedAt: finite(close.lastModified) ?? (timeOf(close) || undefined),
        stopLoss: sl && sl > 0 ? sl : undefined,
        takeProfit: tp && tp > 0 ? tp : undefined,
        strategyId: String(opener.strategyId ?? '').trim(),
      })
    }
  }
  return out
}

/**
 * Gross profit in account currency. Only computed when the quote currency equals the account
 * currency, since no conversion rate is available; otherwise undefined.
 */
export function grossProfit(args: {
  side: 'buy' | 'sell'
  lots: number
  openPrice: number | undefined
  closePrice: number | undefined
  contractSize: number | undefined
  quotingCurrency: string | undefined
  accountCurrency: string | undefined
}): number | undefined {
  const { openPrice, closePrice, contractSize } = args
  if (openPrice == null || closePrice == null || !contractSize || !(contractSize > 0)) return undefined
  if (!args.quotingCurrency || !args.accountCurrency) return undefined
  if (args.quotingCurrency.toUpperCase() !== args.accountCurrency.toUpperCase()) return undefined
  const direction = args.side === 'buy' ? 1 : -1
  return Number(((closePrice - openPrice) * direction * args.lots * contractSize).toFixed(2))
}
