/**
 * DXtrade instrument helpers: symbol matching, lot/unit conversion, client order codes.
 *
 * Orders carry quantity in units, not lots. One lot is `lotSize` units (instrument field).
 * Client order codes (`orderCode`) must be unique per account, at most 64 characters, case sensitive.
 */
import { floorToStep } from '../bybit/symbols'

export interface DxtradeInstrument {
  symbol: string
  /** Units in one lot. */
  lotSize: number
  pipSize?: number
  priceIncrement?: number
  /** Smallest quantity step, in units. */
  quantityIncrement?: number
  currency?: string
  type?: string
}

export const ORDER_CODE_PREFIX = 'TSC'
export const CLOSE_CODE_PREFIX = 'TSX'
const CODE_MAX = 64

export function normalizeSymbolKey(symbol: string): string {
  return String(symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Match a signal symbol (XAUUSD) to a broker symbol (XAU/USD, XAUUSD.m). Exact first, then one suffix away. */
export function matchInstrument<T extends { symbol: string }>(list: Iterable<T>, wanted: string): T | undefined {
  const key = normalizeSymbolKey(wanted)
  if (!key) return undefined
  const all = [...list]
  const exact = all.find(item => item.symbol === wanted) ?? all.find(item => normalizeSymbolKey(item.symbol) === key)
  if (exact) return exact
  return all
    .filter(item => {
      const k = normalizeSymbolKey(item.symbol)
      return k.startsWith(key) && k.length - key.length <= 4
    })
    .sort((a, b) => a.symbol.length - b.symbol.length)[0]
}

export class DxtradeSizingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DxtradeSizingError'
  }
}

export function lotsToUnits(lots: number, instrument: DxtradeInstrument): number {
  if (!(lots > 0)) throw new DxtradeSizingError('Lot size must be above 0')
  const lotSize = instrument.lotSize > 0 ? instrument.lotSize : 1
  const raw = Number((lots * lotSize).toPrecision(12))
  const step = instrument.quantityIncrement && instrument.quantityIncrement > 0 ? instrument.quantityIncrement : 1
  const units = floorToStep(raw, step)
  if (!(units > 0)) {
    throw new DxtradeSizingError(`${instrument.symbol} needs at least ${step} units (${Number((step / lotSize).toPrecision(6))} lots)`)
  }
  return units
}

export function unitsToLots(units: number, instrument: Pick<DxtradeInstrument, 'lotSize'> | undefined): number {
  const lotSize = instrument && instrument.lotSize > 0 ? instrument.lotSize : 1
  return Number((units / lotSize).toPrecision(10))
}

export function formatNumber(value: number): string {
  // Plain decimal text, never exponent notation (the API takes W3C doubles but brokers differ).
  if (!Number.isFinite(value)) return '0'
  const text = String(value)
  if (!/e/i.test(text)) return text
  return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '')
}

function fnv(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

/** Signal id tail of a copier comment (`TScopier:slug:<signal id>:...`), safe for an order code. */
export function commentTail(comment: string | undefined): string {
  const parts = String(comment ?? '').split(':').map(part => part.trim()).filter(Boolean)
  const idIndex = parts.findIndex((part, index) => index > 0 && /^[a-f0-9]{8}/i.test(part))
  const tail = idIndex >= 0 ? parts.slice(idIndex).join(':') : ''
  return tail.replace(/_/g, '').replace(/[^A-Za-z0-9:.-]/g, '').replace(/:/g, '_').replace(/\./g, '-')
}

/**
 * Entry order code: `TSC_<signal tail>_<fingerprint>_<time bucket>`.
 * The fingerprint covers symbol, side, size and prices, and the bucket spans two minutes, so a
 * retry of the same order maps to the same code and the broker rejects it as a duplicate (409).
 */
export function entryOrderCode(args: {
  comment?: string
  symbol: string
  operation: string
  units: number
  price?: number | null
  stopLoss?: number | null
  takeProfit?: number | null
  now: number
}): string {
  const finger = fnv([args.symbol, args.operation, args.units, args.price ?? '', args.stopLoss ?? '', args.takeProfit ?? ''].join('|')).toString(36)
  const bucket = Math.floor(args.now / 120_000).toString(36)
  const tail = commentTail(args.comment).slice(0, 30)
  const code = tail ? `${ORDER_CODE_PREFIX}_${tail}_${finger}_${bucket}` : `${ORDER_CODE_PREFIX}_${finger}_${bucket}`
  return code.slice(0, CODE_MAX - 4)
}

export function protectionOrderCode(entryCode: string, kind: 'SL' | 'TP'): string {
  return `${entryCode}_${kind}`.slice(0, CODE_MAX)
}

/** Unique code for orders that follow an existing position (close, protection add). */
export function actionOrderCode(prefix: string, ticket: number, now: number, nonce: string): string {
  return `${prefix}_${ticket}_${now.toString(36)}${nonce}`.slice(0, CODE_MAX)
}

export function isCopierOrderCode(value: unknown): boolean {
  return /^TSC_/.test(String(value ?? ''))
}

/** Readable `TScopier:<tail>` comment from an entry code. */
export function commentFromOrderCode(value: unknown): string {
  const text = String(value ?? '')
  if (!isCopierOrderCode(text)) return ''
  const body = text.replace(/^TSC_/, '').replace(/_(SL|TP)$/, '')
  // Drop `<fingerprint>_<bucket>`.
  const trimmed = body.replace(/_[0-9a-z]{1,8}_[0-9a-z]{1,8}$/, '')
  if (!trimmed || trimmed === body) return ''
  return `TScopier:${trimmed.replace(/_/g, ':').replace(/-/g, '.')}`
}

/** Position codes equal the opening order id (numeric). Anything else hashes onto a positive 32-bit int. */
export function ticketFromCode(code: unknown): number {
  const text = String(code ?? '').trim()
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  return fnv(text) + 1
}

export function sideForOperation(operation: string): 'BUY' | 'SELL' {
  return /sell/i.test(operation) ? 'SELL' : 'BUY'
}

export function orderTypeForOperation(operation: string): 'MARKET' | 'LIMIT' | 'STOP' {
  if (/limit/i.test(operation)) return 'LIMIT'
  if (/stop/i.test(operation)) return 'STOP'
  return 'MARKET'
}

export function oppositeSide(side: string): 'BUY' | 'SELL' {
  return String(side).toUpperCase() === 'BUY' ? 'SELL' : 'BUY'
}

/** Round a price to the instrument's increment. */
export function roundPrice(price: number, instrument: Pick<DxtradeInstrument, 'priceIncrement'> | undefined): number {
  const step = instrument?.priceIncrement
  if (!step || !(step > 0)) return price
  const decimals = (() => {
    const text = String(step)
    if (text.includes('e-')) return Number(text.split('e-')[1])
    const dot = text.indexOf('.')
    return dot === -1 ? 0 : text.length - dot - 1
  })()
  return Number((Math.round(price / step) * step).toFixed(decimals))
}
