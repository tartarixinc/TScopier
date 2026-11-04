/** Binance USD-M symbol rules: name mapping and position sizing from margin x leverage. */

export interface BinanceSymbolRules {
  symbol: string
  status: string
  pricePrecision: number
  quantityPrecision: number
  tickSize: number
  stepSize: number
  minQty: number
  maxQty: number
  minNotional: number
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Parse `GET /fapi/v1/exchangeInfo` into a symbol map. */
export function parseExchangeInfo(body: unknown): Map<string, BinanceSymbolRules> {
  const out = new Map<string, BinanceSymbolRules>()
  const symbols = body && typeof body === 'object' ? (body as { symbols?: unknown }).symbols : null
  if (!Array.isArray(symbols)) return out
  for (const raw of symbols) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const symbol = String(row.symbol ?? '').toUpperCase()
    if (!symbol) continue
    const filters = Array.isArray(row.filters) ? row.filters as Array<Record<string, unknown>> : []
    const find = (type: string) => filters.find(f => f?.filterType === type)
    const price = find('PRICE_FILTER')
    const lot = find('LOT_SIZE')
    const market = find('MARKET_LOT_SIZE')
    const notional = find('MIN_NOTIONAL')
    const maxLot = num(lot?.maxQty)
    const maxMarket = num(market?.maxQty)
    out.set(symbol, {
      symbol,
      status: String(row.status ?? ''),
      pricePrecision: num(row.pricePrecision),
      quantityPrecision: num(row.quantityPrecision),
      tickSize: num(price?.tickSize),
      stepSize: num(lot?.stepSize),
      minQty: num(lot?.minQty),
      maxQty: maxMarket > 0 && (maxLot <= 0 || maxMarket < maxLot) ? maxMarket : maxLot,
      minNotional: num(notional?.notional ?? notional?.minNotional),
    })
  }
  return out
}

/**
 * Map a signal symbol to a Binance perpetual. `XAUUSD` becomes `XAUUSDT`,
 * `BTC/USDT` and `BTCUSDT.P` become `BTCUSDT`. Returns null when none is listed.
 */
export function resolveBinanceSymbol(
  input: string,
  symbols: ReadonlyMap<string, BinanceSymbolRules>,
): BinanceSymbolRules | null {
  let base = String(input ?? '').trim().toUpperCase()
  if (!base) return null
  base = base.replace(/\.P$/, '').replace(/PERP$/, '').replace(/[^A-Z0-9]/g, '')
  const candidates = [base]
  if (base.endsWith('USD')) candidates.push(`${base}T`)
  if (base.endsWith('USDT') || base.endsWith('USDC')) {
    // already quoted
  } else if (!base.endsWith('USD')) {
    candidates.push(`${base}USDT`)
  }
  for (const candidate of candidates) {
    const found = symbols.get(candidate)
    if (found && (found.status === 'TRADING' || found.status === '')) return found
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

export function formatQuantity(quantity: number, rules: Pick<BinanceSymbolRules, 'stepSize' | 'quantityPrecision'>): string {
  const places = rules.stepSize > 0 ? decimals(rules.stepSize) : rules.quantityPrecision
  return quantity.toFixed(places)
}

export function formatPrice(price: number, rules: Pick<BinanceSymbolRules, 'tickSize' | 'pricePrecision'>): string {
  const places = rules.tickSize > 0 ? decimals(rules.tickSize) : rules.pricePrecision
  if (rules.tickSize > 0) {
    const scale = 10 ** places
    const tick = Math.round(rules.tickSize * scale)
    const units = Math.round(price * scale)
    return (Math.round(units / tick) * tick / scale).toFixed(places)
  }
  return price.toFixed(places)
}

export class BinanceSizingError extends Error {}

/**
 * Quantity for one signal: notional = margin x leverage, quantity = notional / price,
 * rounded down to the symbol step and checked against min quantity and min notional.
 */
export function sizeBinancePosition(args: {
  marginUsdt: number
  leverage: number
  price: number
  rules: BinanceSymbolRules
}): number {
  const { marginUsdt, leverage, price, rules } = args
  if (!(marginUsdt > 0)) throw new BinanceSizingError('Binance margin is not set for this account')
  if (!(leverage >= 1)) throw new BinanceSizingError('Binance leverage is not set for this account')
  if (!(price > 0)) throw new BinanceSizingError(`Binance price for ${rules.symbol} is unavailable`)
  const notional = marginUsdt * leverage
  let quantity = floorToStep(notional / price, rules.stepSize)
  if (rules.maxQty > 0 && quantity > rules.maxQty) quantity = floorToStep(rules.maxQty, rules.stepSize)
  const tooSmall = quantity <= 0
    || (rules.minQty > 0 && quantity < rules.minQty)
    || (rules.minNotional > 0 && quantity * price < rules.minNotional)
  if (tooSmall) {
    const floor = Math.max(rules.minNotional, rules.minQty * price)
    throw new BinanceSizingError(
      `${marginUsdt} USDT margin at ${leverage}x is below the Binance minimum order for ${rules.symbol}`
      + (floor > 0 ? ` (about ${Math.ceil(floor)} USDT notional). Raise the margin or leverage.` : '.'),
    )
  }
  return quantity
}

/** Client order ids allow 36 characters of `A-Za-z0-9:._-`. */
export function copierClientOrderId(comment: string | undefined, nonce: string): string {
  const raw = String(comment ?? '').trim()
  const parts = raw.split(':').map(s => s.trim()).filter(Boolean)
  // Keep the signal id and any tp/refresh tail. The channel slug is dropped to fit 36 chars.
  const idIndex = parts.findIndex((part, index) => index > 0 && /^[a-f0-9]{8}/i.test(part))
  const tail = idIndex >= 0 ? parts.slice(idIndex).join(':') : ''
  const safe = tail.replace(/[^A-Za-z0-9:._-]/g, '')
  const head = safe ? `TScopier:${safe}` : 'TScopier'
  const room = 36 - nonce.length - 1
  return `${head.slice(0, Math.max(9, room))}:${nonce}`
}
