/**
 * KuCoin Futures contract rules: name mapping and position sizing from margin x leverage.
 *
 * KuCoin sizes orders in integer lots. One lot is `multiplier` units of the base asset
 * (0.001 BTC for XBTUSDTM, 520000 for PEPEUSDTM). Only linear contracts settled in USDT or
 * USDC are handled; inverse contracts are skipped.
 *
 * Client order ids (`clientOid`) share the Bybit format, so the helpers are reused:
 * 40 characters allowed, we use at most 36 of `[A-Za-z0-9_-]`.
 */
export {
  CLOSE_PREFIX,
  LINK_PREFIX,
  SL_PREFIX,
  TICKET_EPOCH_MS,
  TP_PREFIX,
  childOrderLinkId,
  commentFromOrderLinkId,
  copierOrderLinkId,
  floorToStep,
  hashOrderId,
  isCopierLinkId,
  ticketFromChildLinkId,
  ticketFromEntryLinkId,
  ticketToken,
} from '../bybit/symbols'

export interface KucoinContract {
  symbol: string
  status: string
  baseCurrency: string
  settleCurrency: string
  /** Base-asset units in one lot. */
  multiplier: number
  /** Order size step, in lots. */
  lotSize: number
  tickSize: number
  /** Largest limit order, in lots. */
  maxOrderQty: number
  /** Largest market order, in lots. */
  maxMarketQty: number
  maxLeverage: number
  isInverse: boolean
  supportCross: boolean
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Parse `GET /api/v1/contracts/active` into a symbol map. */
export function parseContracts(data: unknown, into: Map<string, KucoinContract> = new Map()): Map<string, KucoinContract> {
  if (!Array.isArray(data)) return into
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const symbol = String(row.symbol ?? '').toUpperCase()
    if (!symbol) continue
    into.set(symbol, {
      symbol,
      status: String(row.status ?? ''),
      baseCurrency: String(row.baseCurrency ?? '').toUpperCase(),
      settleCurrency: String(row.settleCurrency ?? '').toUpperCase(),
      multiplier: num(row.multiplier),
      lotSize: num(row.lotSize) || 1,
      tickSize: num(row.tickSize),
      maxOrderQty: num(row.maxOrderQty),
      maxMarketQty: num(row.marketMaxOrderQty),
      maxLeverage: num(row.maxLeverage),
      isInverse: row.isInverse === true,
      supportCross: row.supportCross !== false,
    })
  }
  return into
}

function isTradable(contract: KucoinContract): boolean {
  return (contract.status === 'Open' || contract.status === '')
    && !contract.isInverse
    && contract.multiplier > 0
    && (contract.settleCurrency === 'USDT' || contract.settleCurrency === 'USDC')
}

/** KuCoin calls Bitcoin `XBT`. */
const BASE_ALIASES: Record<string, string[]> = {
  BTC: ['XBT'],
}

/**
 * Map a signal symbol to a KuCoin linear contract.
 * `BTCUSDT`, `BTC/USDT` and `BTCUSDT.P` become `XBTUSDTM`; `ETHUSDC` becomes `ETHUSDCM`.
 * `XAUUSD` and bare bases fall back to the USDT contract. An exact listed name wins.
 * Returns null when nothing tradable matches.
 */
export function resolveKucoinSymbol(
  input: string,
  contracts: ReadonlyMap<string, KucoinContract>,
): KucoinContract | null {
  const raw = String(input ?? '').trim().toUpperCase()
  if (!raw) return null
  const exact = contracts.get(raw)
  if (exact && isTradable(exact)) return exact

  const cleaned = raw.replace(/\.P$/, '').replace(/PERP$/, '').replace(/[^A-Z0-9]/g, '')
  if (!cleaned) return null
  const direct = contracts.get(cleaned)
  if (direct && isTradable(direct)) return direct

  let base = cleaned
  let settle = 'USDT'
  if (cleaned.endsWith('USDT')) {
    base = cleaned.slice(0, -4)
  } else if (cleaned.endsWith('USDC')) {
    base = cleaned.slice(0, -4)
    settle = 'USDC'
  } else if (cleaned.endsWith('USD')) {
    base = cleaned.slice(0, -3)
  }
  if (!base) return null

  const bases = [...(BASE_ALIASES[base] ?? []), base]
  if (!base.startsWith('1000') && !base.startsWith('10000')) bases.push(`1000${base}`)
  if (base.startsWith('1000')) bases.push(base.replace(/^1000/, ''))
  const settles = settle === 'USDT' ? ['USDT'] : [settle, 'USDT']
  for (const candidateBase of bases) {
    for (const candidateSettle of settles) {
      const found = contracts.get(`${candidateBase}${candidateSettle}M`)
      if (found && isTradable(found)) return found
    }
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

/** Price rounded to the contract tick, as the string KuCoin expects. */
export function formatPrice(price: number, contract: Pick<KucoinContract, 'tickSize'>): string {
  const places = decimals(contract.tickSize)
  if (contract.tickSize > 0) {
    const scale = 10 ** places
    const tick = Math.round(contract.tickSize * scale)
    const units = Math.round(price * scale)
    return (Math.round(units / tick) * tick / scale).toFixed(places)
  }
  return price.toFixed(places)
}

/** Lots as base-asset units, free of float noise. */
export function lotsToBase(lots: number, contract: Pick<KucoinContract, 'multiplier'>): number {
  return Number((lots * contract.multiplier).toPrecision(12))
}

/** Base-asset units as whole lots, rounded to the nearest lot. */
export function baseToLots(base: number, contract: Pick<KucoinContract, 'multiplier'>): number {
  return Math.round(base / contract.multiplier)
}

export class KucoinSizingError extends Error {}

/**
 * Lots for one signal: notional = margin x leverage, base quantity = notional / price,
 * lots = floor(base quantity / multiplier) to the lot step. Market orders are capped at the
 * contract's market maximum, limit orders at its limit maximum.
 */
export function sizeKucoinPosition(args: {
  marginUsdt: number
  leverage: number
  price: number
  contract: KucoinContract
  kind?: 'market' | 'limit'
}): number {
  const { marginUsdt, leverage, price, contract } = args
  const currency = contract.settleCurrency || 'USDT'
  if (!(marginUsdt > 0)) throw new KucoinSizingError('KuCoin margin is not set for this account')
  if (!(leverage >= 1)) throw new KucoinSizingError('KuCoin leverage is not set for this account')
  if (!(price > 0)) throw new KucoinSizingError(`KuCoin price for ${contract.symbol} is unavailable`)
  if (contract.maxLeverage > 0 && leverage > contract.maxLeverage) {
    throw new KucoinSizingError(`${leverage}x leverage is above the KuCoin maximum of ${contract.maxLeverage}x for ${contract.symbol}`)
  }
  const notional = marginUsdt * leverage
  const step = contract.lotSize > 0 ? contract.lotSize : 1
  let lots = Math.floor(Math.floor(notional / price / contract.multiplier + 1e-9) / step) * step
  const cap = args.kind === 'limit'
    ? contract.maxOrderQty
    : (contract.maxMarketQty > 0 ? contract.maxMarketQty : contract.maxOrderQty)
  if (cap > 0 && lots > cap) lots = Math.floor(cap / step) * step
  if (lots < step || lots <= 0) {
    const oneLot = contract.multiplier * price * step
    throw new KucoinSizingError(
      `${marginUsdt} ${currency} margin at ${leverage}x is below one ${contract.symbol} lot`
      + ` (about ${Math.ceil(oneLot)} ${currency} notional). Raise the margin or leverage.`,
    )
  }
  return lots
}
