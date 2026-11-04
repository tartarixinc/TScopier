/**
 * Match-Trader instrument helpers: symbol matching, lot sizing, ids and comment tags.
 *
 * Orders carry `volume` in lots (the docs show 0.01). Writes have no client order id or comment, so the
 * provider keeps the signal comment per order id (see matchtraderProvider tag store).
 */
import { floorToStep } from '../bybit/symbols'

export interface MatchtraderInstrument {
  /** Broker symbol, used on every request (for example `EURUSD.test`). */
  symbol: string
  /** Display name (for example `EURUSD`). */
  alias: string
  volumeMin: number | undefined
  volumeMax: number | undefined
  volumeStep: number | undefined
  volumePrecision: number | undefined
  contractSize: number | undefined
  pricePrecision: number | undefined
  sizeOfOnePoint: number | undefined
  quoteCurrency: string | undefined
}

export class MatchtraderSizingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MatchtraderSizingError'
  }
}

export function normalizeSymbolKey(symbol: string): string {
  return String(symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Match a signal symbol (XAUUSD) to a broker symbol or alias. Exact first, then one suffix away. */
export function matchInstrument(list: Iterable<MatchtraderInstrument>, wanted: string): MatchtraderInstrument | undefined {
  const key = normalizeSymbolKey(wanted)
  if (!key) return undefined
  const all = [...list]
  const names = (item: MatchtraderInstrument) => [item.symbol, item.alias].filter(Boolean)
  const exact = all.find(item => names(item).includes(wanted))
    ?? all.find(item => names(item).some(name => normalizeSymbolKey(name) === key))
  if (exact) return exact
  return all
    .filter(item => names(item).some(name => {
      const k = normalizeSymbolKey(name)
      return k.startsWith(key) && k.length - key.length <= 4
    }))
    .sort((a, b) => a.symbol.length - b.symbol.length)[0]
}

function decimalsOf(step: number): number {
  const text = String(step)
  if (text.includes('e-')) return Number(text.split('e-')[1])
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

/**
 * Lot limits are only trusted when they look like lots. The docs sample shows `volumeMin: 10`,
 * `volumeStep: 10` with `contractSize: 1`, which reads as units, so values above 1 are ignored and the
 * broker decides. `volumePrecision` still sets the step (10^-precision, default 0.01).
 */
export function lotLimits(inst: Pick<MatchtraderInstrument, 'volumeMin' | 'volumeMax' | 'volumeStep' | 'volumePrecision'>): {
  step: number
  min: number
  max: number | undefined
} {
  const precision = inst.volumePrecision != null && inst.volumePrecision >= 0 && inst.volumePrecision <= 8
    ? Math.floor(inst.volumePrecision)
    : 2
  const precisionStep = 10 ** -precision
  const looksLikeLots = (inst.volumeStep ?? 0) > 0 && (inst.volumeStep ?? 0) <= 1 && (inst.volumeMin ?? 0) <= 1
  const step = looksLikeLots ? inst.volumeStep! : precisionStep
  const min = looksLikeLots && inst.volumeMin && inst.volumeMin > 0 ? inst.volumeMin : step
  const max = looksLikeLots && inst.volumeMax && inst.volumeMax > 0 ? inst.volumeMax : undefined
  return { step, min, max }
}

/** Floor signal lots to the lot step and check the minimum and maximum. */
export function sizeLots(lots: number, symbol: string, inst: Pick<MatchtraderInstrument, 'volumeMin' | 'volumeMax' | 'volumeStep' | 'volumePrecision'>): number {
  if (!(lots > 0)) throw new MatchtraderSizingError('Lot size must be above 0')
  const { step, min, max } = lotLimits(inst)
  const qty = floorToStep(Number(lots.toPrecision(12)), step)
  if (!(qty > 0) || qty < min - 1e-12) {
    throw new MatchtraderSizingError(`${symbol} needs at least ${min} lots (the signal size ${lots} is below it)`)
  }
  if (max && qty > max + 1e-12) {
    throw new MatchtraderSizingError(`${symbol} allows at most ${max} lots per order`)
  }
  return Number(qty.toFixed(decimalsOf(step)))
}

export function priceDecimals(inst: Pick<MatchtraderInstrument, 'pricePrecision' | 'sizeOfOnePoint'>): number {
  if (inst.pricePrecision != null && inst.pricePrecision >= 0 && inst.pricePrecision <= 10) return Math.floor(inst.pricePrecision)
  if (inst.sizeOfOnePoint && inst.sizeOfOnePoint > 0) return decimalsOf(inst.sizeOfOnePoint)
  return 5
}

export function roundPrice(price: number, inst: Pick<MatchtraderInstrument, 'pricePrecision' | 'sizeOfOnePoint'>): number {
  return Number(price.toFixed(priceDecimals(inst)))
}

/** Match-Trader ids look like `W6910422326264457`. The numeric part is the ticket used by the copier. */
export function ticketFromId(id: unknown): number {
  const digits = String(id ?? '').replace(/\D/g, '')
  if (!digits) return 0
  const n = Number(digits)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/** Key a tag by the digits of an id, so `W123` and `123` meet. */
export function tagKey(id: unknown): string {
  return String(id ?? '').replace(/\D/g, '')
}

export function sideForOperation(operation: string): 'BUY' | 'SELL' {
  return /sell/i.test(operation) ? 'SELL' : 'BUY'
}

export function orderTypeForOperation(operation: string): 'market' | 'limit' | 'stop' {
  if (/limit/i.test(operation)) return 'limit'
  if (/stop/i.test(operation)) return 'stop'
  return 'market'
}

export function operationFor(type: string, side: string): string {
  const buy = String(side).toLowerCase() === 'buy'
  const t = type.toLowerCase()
  if (t.includes('limit')) return buy ? 'BuyLimit' : 'SellLimit'
  if (t.includes('stop')) return buy ? 'BuyStop' : 'SellStop'
  return buy ? 'Buy' : 'Sell'
}

function fnv(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

/**
 * Key of one entry attempt: symbol, side, size, prices and comment, bucketed to two minutes. A retry of
 * the same order maps to the same key, so it can be reconciled instead of sent blind.
 */
export function entryKey(args: {
  comment?: string
  symbol: string
  operation: string
  qty: number
  price?: number | null
  stopLoss?: number | null
  takeProfit?: number | null
  now: number
}): string {
  const finger = fnv([args.symbol, args.operation, args.qty, args.price ?? '', args.stopLoss ?? '', args.takeProfit ?? '', args.comment ?? ''].join('|')).toString(36)
  return `${finger}.${Math.floor(args.now / 120_000).toString(36)}`
}

export interface TagEntry {
  comment: string
  symbol: string
  side: 'buy' | 'sell'
  /** Epoch ms the order was opened. */
  at: number
}

/** Positive finite number or undefined. */
export function positive(value: number | null | undefined): number | undefined {
  const n = value == null ? undefined : Number(value)
  return n != null && Number.isFinite(n) && n > 0 ? n : undefined
}

export function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Server timestamps carry no zone ("2024-07-13T04:30:35"); they are read as UTC. */
export function parseServerTime(value: unknown): number | undefined {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`
  const ms = Date.parse(withZone)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Comment for each id. Exact digit-key match first; rows left over are matched greedily to unused tags
 * of the same symbol and side opened within 60 seconds.
 */
export function resolveComments(
  rows: Array<{ id: string; symbol: string; side: 'buy' | 'sell'; at: number | undefined }>,
  tags: Map<string, TagEntry>,
): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const row of rows) {
    const key = tagKey(row.id)
    const hit = tags.get(key)
    if (hit) {
      out.set(row.id, hit.comment)
      used.add(key)
    }
  }
  for (const row of rows) {
    if (out.has(row.id) || row.at == null) continue
    let best: { key: string; gap: number } | null = null
    for (const [key, entry] of tags) {
      if (used.has(key)) continue
      if (normalizeSymbolKey(entry.symbol) !== normalizeSymbolKey(row.symbol) || entry.side !== row.side) continue
      const gap = Math.abs(entry.at - row.at)
      if (gap <= 60_000 && (!best || gap < best.gap)) best = { key, gap }
    }
    if (best) {
      used.add(best.key)
      out.set(row.id, tags.get(best.key)!.comment)
    }
  }
  return out
}
