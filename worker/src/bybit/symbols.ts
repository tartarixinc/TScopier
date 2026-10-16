/** Bybit linear symbol rules: name mapping, position sizing from margin x leverage, order link ids. */

export interface BybitSymbolRules {
  symbol: string
  status: string
  contractType: string
  settleCoin: string
  tickSize: number
  qtyStep: number
  minQty: number
  /** Largest limit order. */
  maxQty: number
  /** Largest market order. */
  maxMarketQty: number
  minNotional: number
  minLeverage: number
  maxLeverage: number
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Parse the `result` of `GET /v5/market/instruments-info?category=linear` into a symbol map. */
export function parseInstruments(result: unknown, into: Map<string, BybitSymbolRules> = new Map()): Map<string, BybitSymbolRules> {
  const list = result && typeof result === 'object' ? (result as { list?: unknown }).list : null
  if (!Array.isArray(list)) return into
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const symbol = String(row.symbol ?? '').toUpperCase()
    if (!symbol) continue
    const price = (row.priceFilter ?? {}) as Record<string, unknown>
    const lot = (row.lotSizeFilter ?? {}) as Record<string, unknown>
    const leverage = (row.leverageFilter ?? {}) as Record<string, unknown>
    into.set(symbol, {
      symbol,
      status: String(row.status ?? ''),
      contractType: String(row.contractType ?? ''),
      settleCoin: String(row.settleCoin ?? '').toUpperCase(),
      tickSize: num(price.tickSize),
      qtyStep: num(lot.qtyStep),
      minQty: num(lot.minOrderQty),
      maxQty: num(lot.maxOrderQty),
      maxMarketQty: num(lot.maxMktOrderQty),
      minNotional: num(lot.minNotionalValue),
      minLeverage: num(leverage.minLeverage),
      maxLeverage: num(leverage.maxLeverage),
    })
  }
  return into
}

function isTradable(rules: BybitSymbolRules): boolean {
  return rules.status === 'Trading' || rules.status === ''
}

/**
 * Map a signal symbol to a Bybit linear contract. `XAUUSD` becomes `XAUUSDT`,
 * `BTC/USDT` and `BTCUSDT.P` become `BTCUSDT`, `BTC/USDC` becomes `BTCPERP`.
 * An exact listed name (including dated futures like `BTC-26DEC25`) always wins.
 * Returns null when nothing tradable matches.
 */
export function resolveBybitSymbol(
  input: string,
  symbols: ReadonlyMap<string, BybitSymbolRules>,
): BybitSymbolRules | null {
  const raw = String(input ?? '').trim().toUpperCase()
  if (!raw) return null
  const exact = symbols.get(raw)
  if (exact && isTradable(exact)) return exact

  const base = raw.replace(/\.P$/, '').replace(/PERP$/, '').replace(/[^A-Z0-9]/g, '')
  if (!base) return null
  const candidates: string[] = [base]
  if (base.endsWith('USD')) candidates.push(`${base}T`)
  if (base.endsWith('USDC')) {
    candidates.push(`${base.slice(0, -4)}PERP`)
  } else if (!base.endsWith('USDT') && !base.endsWith('USD')) {
    candidates.push(`${base}USDT`)
    candidates.push(`${base}PERP`)
  }
  for (const candidate of candidates) {
    const found = symbols.get(candidate)
    if (found && isTradable(found) && found.contractType !== 'InversePerpetual') return found
  }
  return null
}

function decimals(step: number): number {
  if (!(step > 0)) return 8
  const text = step.toString()
  if (text.includes('e-')) return Number(text.split('e-')[1])
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

/** Round down to the symbol step. Uses integer math on the step to avoid float drift. */
export function floorToStep(value: number, step: number): number {
  if (!(value > 0)) return 0
  if (!(step > 0)) return value
  const places = decimals(step)
  const scale = 10 ** places
  const stepUnits = Math.round(step * scale)
  const units = Math.floor(Math.round(value * scale * 1e6) / 1e6)
  const floored = Math.floor(units / stepUnits) * stepUnits
  return Number((floored / scale).toFixed(places))
}

export function formatQuantity(quantity: number, rules: Pick<BybitSymbolRules, 'qtyStep'>): string {
  return quantity.toFixed(decimals(rules.qtyStep))
}

export function formatPrice(price: number, rules: Pick<BybitSymbolRules, 'tickSize'>): string {
  const places = decimals(rules.tickSize)
  if (rules.tickSize > 0) {
    const scale = 10 ** places
    const tick = Math.round(rules.tickSize * scale)
    const units = Math.round(price * scale)
    return (Math.round(units / tick) * tick / scale).toFixed(places)
  }
  return price.toFixed(places)
}

export class BybitSizingError extends Error {}

/**
 * Quantity for one signal: notional = margin x leverage, quantity = notional / price,
 * rounded down to the symbol step and checked against min quantity and min notional.
 * Market orders are capped at the symbol's market maximum, limit orders at its limit maximum.
 */
export function sizeBybitPosition(args: {
  marginUsdt: number
  leverage: number
  price: number
  rules: BybitSymbolRules
  kind?: 'market' | 'limit'
}): number {
  const { marginUsdt, leverage, price, rules } = args
  const currency = rules.settleCoin || 'USDT'
  if (!(marginUsdt > 0)) throw new BybitSizingError('Bybit margin is not set for this account')
  if (!(leverage >= 1)) throw new BybitSizingError('Bybit leverage is not set for this account')
  if (!(price > 0)) throw new BybitSizingError(`Bybit price for ${rules.symbol} is unavailable`)
  if (rules.maxLeverage > 0 && leverage > rules.maxLeverage) {
    throw new BybitSizingError(`${leverage}x leverage is above the Bybit maximum of ${rules.maxLeverage}x for ${rules.symbol}`)
  }
  const notional = marginUsdt * leverage
  const cap = args.kind === 'limit'
    ? rules.maxQty
    : (rules.maxMarketQty > 0 ? rules.maxMarketQty : rules.maxQty)
  let quantity = floorToStep(notional / price, rules.qtyStep)
  if (cap > 0 && quantity > cap) quantity = floorToStep(cap, rules.qtyStep)
  const tooSmall = quantity <= 0
    || (rules.minQty > 0 && quantity < rules.minQty)
    || (rules.minNotional > 0 && quantity * price < rules.minNotional)
  if (tooSmall) {
    const floor = Math.max(rules.minNotional, rules.minQty * price)
    throw new BybitSizingError(
      `${marginUsdt} ${currency} margin at ${leverage}x is below the Bybit minimum order for ${rules.symbol}`
      + (floor > 0 ? ` (about ${Math.ceil(floor)} ${currency} notional). Raise the margin or leverage.` : '.'),
    )
  }
  return quantity
}

// ── Order link ids ─────────────────────────────────────────────────────────
// Bybit allows 36 characters of letters, digits, `-` and `_`, unique per order.
// Entry ids look like `TScopier_<signal tail>_<ticket in base 36>` with `:` stored as `_`
// and `.` as `-`. Stop and close ids look like `TSL_<ticket>_<nonce>` (decimal ticket).
// The base-36 ticket keeps the entry id short so the signal tail (`rg5.tp1`) survives.

export const LINK_PREFIX = 'TScopier'
export const SL_PREFIX = 'TSL'
export const TP_PREFIX = 'TST'
export const CLOSE_PREFIX = 'TSX'
const LINK_MAX = 36

/** Tickets count milliseconds since this epoch (x16), which keeps them short and increasing. */
export const TICKET_EPOCH_MS = Date.UTC(2024, 0, 1)

export function ticketToken(ticket: number): string {
  return ticket.toString(36)
}

export function copierOrderLinkId(comment: string | undefined, ticket: number): string {
  const raw = String(comment ?? '').trim()
  const parts = raw.split(':').map(s => s.trim()).filter(Boolean)
  // Keep the signal id and any tp/refresh tail. The channel slug is dropped to fit 36 chars.
  const idIndex = parts.findIndex((part, index) => index > 0 && /^[a-f0-9]{8}/i.test(part))
  const tail = idIndex >= 0 ? parts.slice(idIndex).join(':') : ''
  const encoded = tail
    .replace(/_/g, '')
    .replace(/[^A-Za-z0-9:.-]/g, '')
    .replace(/:/g, '_')
    .replace(/\./g, '-')
  const suffix = `_${ticketToken(ticket)}`
  const room = LINK_MAX - LINK_PREFIX.length - 1 - suffix.length
  if (!encoded || room < 2) return `${LINK_PREFIX}${suffix}`
  return `${LINK_PREFIX}_${encoded.slice(0, room)}${suffix}`
}

/** Readable `TScopier:<tail>` comment recovered from an entry order link id. */
export function commentFromOrderLinkId(linkId: unknown): string {
  const text = String(linkId ?? '')
  if (!isCopierLinkId(text)) return text
  const stripped = text.replace(/_[0-9a-z]{6,10}$/, '')
  return stripped.replace(/_/g, ':').replace(/-/g, '.')
}

export function isCopierLinkId(value: unknown): boolean {
  return /^TS[Cc]opier/.test(String(value ?? ''))
}

/** Ticket from an entry link id (`TScopier_..._<ticket in base 36>`). */
export function ticketFromEntryLinkId(value: unknown): number | null {
  const text = String(value ?? '')
  if (!isCopierLinkId(text)) return null
  const match = /_([0-9a-z]{6,10})$/.exec(text)
  if (!match) return null
  const n = parseInt(match[1]!, 36)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Ticket from a stop or close link id (`TSL_<ticket>_<nonce>`). */
export function ticketFromChildLinkId(value: unknown, prefix: string): number | null {
  const text = String(value ?? '')
  if (!text.startsWith(`${prefix}_`)) return null
  const n = Number(text.split('_')[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export function childOrderLinkId(prefix: string, ticket: number, nonce: string): string {
  return `${prefix}_${ticket}_${nonce}`
}

/** Order ids are UUID-like strings. Map them onto a positive 32-bit integer for display tickets. */
export function hashOrderId(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash + 1
}
