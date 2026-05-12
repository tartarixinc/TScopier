/**
 * Broker-driven pip calculator (standard myfxbook convention).
 *
 * Produces both:
 *   • `pipPrice` — the price-unit size of 1 pip (e.g. 0.10 on XAUUSD).
 *     Used by the planner for SL/TP placement and range-step math.
 *   • `pipValuePer{Std,Mini,Micro}Lot` — the quote-currency value of 1 pip
 *     on a 1.00 / 0.10 / 0.01 lot. Used by the UI for risk hints (and
 *     eventually by auto-sizing logic).
 *
 * Both values are derived from the broker's `/SymbolParams` data
 * (`point`, `digits`, `contractSize`) so exotic contracts — e.g. a 10-oz
 * XAUUSD instead of the standard 100-oz, or a 0.01-BTC instead of 1-BTC —
 * are handled automatically.
 *
 * Conventions follow the **standard myfxbook** definition:
 *   FX major          1 pip = 0.0001 price → $10 per 1.00 lot
 *   USDJPY            1 pip = 0.01 price   → 1000 JPY per 1.00 lot
 *   XAUUSD            1 pip = 0.10 price   → $10 per 1.00 lot
 *   XAGUSD            1 pip = 0.01 price   → $50 per 1.00 lot (5000 oz)
 *
 * Pip values are returned in the symbol's **quote currency**. We do not
 * convert to the account currency here — that's a phase-2 concern when
 * we add an FX rate cache. The `quoteCurrency` field on `PipQuote` tells
 * callers which currency the value is in.
 */

import { classifySymbol, type SymbolClass } from './pipMath'

export interface PipQuote {
  /** Price-unit size of 1 pip (e.g. 0.10 on XAU, 0.0001 on EURUSD). */
  pipPrice: number
  /** Quote-currency value of 1 pip on a 1.00 lot. */
  pipValuePerStdLot: number
  /** Quote-currency value of 1 pip on a 0.10 lot. */
  pipValuePerMiniLot: number
  /** Quote-currency value of 1 pip on a 0.01 lot. */
  pipValuePerMicroLot: number
  /** Units in 1.00 standard lot — broker-reported when available. */
  contractSize: number
  /** ISO-4217 quote currency for the pip value, or null when unknown. */
  quoteCurrency: string | null
  /** Symbol classification (FX, metal, index, etc.). */
  class: SymbolClass
}

const FX_DEFAULT_CONTRACT_SIZE = 100_000
const XAU_DEFAULT_CONTRACT_SIZE = 100 // ounces
const XAG_DEFAULT_CONTRACT_SIZE = 5_000 // ounces
const INDEX_DEFAULT_CONTRACT_SIZE = 1
const CRYPTO_DEFAULT_CONTRACT_SIZE = 1
const ENERGY_DEFAULT_CONTRACT_SIZE = 1_000 // barrels
const OTHER_DEFAULT_CONTRACT_SIZE = 1

/**
 * Lightweight pull of the quote currency from a symbol name. Only valid for
 * the 6-letter FX/metal layout (e.g. `EURUSD` → `USD`, `XAUUSD` → `USD`,
 * `XAGEUR` → `EUR`); returns null for indices / crypto / energy / exotics
 * because their "quote" varies by broker.
 */
function inferQuoteCurrency(symbol: string, klass: SymbolClass): string | null {
  if (klass !== 'fx_major' && klass !== 'fx_jpy' && klass !== 'metal') return null
  const upper = String(symbol || '').toUpperCase()
  // Allow common broker decorations (e.g. EURUSDm, XAUUSD.r) by stripping the
  // first non-letter character and anything after, then taking the last 3
  // characters of the residue.
  const stripped = upper.replace(/[^A-Z].*$/, '')
  if (stripped.length < 6) return null
  return stripped.slice(-3)
}

/**
 * Resolve the standard-lot contract size: prefer the broker-reported value;
 * fall back to the class default when missing or implausible.
 */
function resolveContractSize(klass: SymbolClass, brokerSize: number | null | undefined): number {
  const n = Number(brokerSize)
  if (Number.isFinite(n) && n > 0) return n
  switch (klass) {
    case 'fx_major':
    case 'fx_jpy':
      return FX_DEFAULT_CONTRACT_SIZE
    case 'metal': {
      // Default is gold (XAU/XPT/XPD); silver overrides below in pipPriceFor.
      return XAU_DEFAULT_CONTRACT_SIZE
    }
    case 'index':
      return INDEX_DEFAULT_CONTRACT_SIZE
    case 'crypto':
      return CRYPTO_DEFAULT_CONTRACT_SIZE
    case 'energy':
      return ENERGY_DEFAULT_CONTRACT_SIZE
    default:
      return OTHER_DEFAULT_CONTRACT_SIZE
  }
}

/**
 * Compute the price-unit size of 1 pip for the given class + broker quote
 * precision. Pure function (no broker call). See file-level docstring for
 * the per-class convention table.
 */
function pipPriceFor(symbol: string, klass: SymbolClass, point: number, digits: number): number {
  const d = Number.isFinite(digits) ? Math.max(0, Math.floor(digits)) : 5

  if (klass === 'fx_major' || klass === 'fx_jpy') {
    // 3/5-digit "fractional pip" quotes expose a sub-pip digit, so 1 pip = 10×point.
    // 2/4-digit quotes pre-date that convention and use 1 pip = point.
    return d === 3 || d === 5 ? point * 10 : point
  }

  if (klass === 'metal') {
    const upper = String(symbol || '').toUpperCase()
    // Silver pip ($0.01) is smaller than gold/platinum/palladium pip ($0.10)
    // because silver trades at ~1/100th the gold price. Both float ABOVE the
    // 10×point baseline so that 3/5-digit brokers can't shrink the pip into
    // the broker's stops_level.
    const floor = upper.includes('XAG') ? 0.01 : 0.10
    return Math.max(point * 10, floor)
  }

  if (klass === 'index') {
    // 0-digit indices (point=1) report 10×point=10 which matches the trader-
    // conventional "1 pip = $1 move" for major indices at point=0.1 brokers;
    // a hard floor of 1.0 keeps the pip sensible even when the broker quotes
    // sub-point precision.
    return Math.max(point * 10, 1)
  }

  // Crypto / energy / other: the broker's `point` is the sub-pip increment.
  return point * 10
}

/**
 * Single canonical pip calculator. All callers (planner, UI hints, future
 * sizing) should route through this function rather than re-deriving pip
 * math from `point × 10`.
 */
export function pipCalculator(
  symbol: string,
  point: number,
  digits: number,
  contractSize?: number | null,
): PipQuote {
  const klass = classifySymbol(symbol)
  const quoteCurrency = inferQuoteCurrency(symbol, klass)

  // Guard against bad broker payloads so callers can always read pipPrice safely.
  if (!Number.isFinite(point) || point <= 0) {
    return {
      pipPrice: 0.0001,
      pipValuePerStdLot: 0,
      pipValuePerMiniLot: 0,
      pipValuePerMicroLot: 0,
      contractSize: resolveContractSize(klass, contractSize),
      quoteCurrency,
      class: klass,
    }
  }

  const pipPrice = pipPriceFor(symbol, klass, point, digits)

  // Resolve the contract size with a silver-aware override (XAG defaults
  // to 5000 oz, not the 100 oz used by gold/platinum/palladium).
  let resolvedContract = resolveContractSize(klass, contractSize)
  if (klass === 'metal') {
    const explicit = Number(contractSize)
    if (!Number.isFinite(explicit) || explicit <= 0) {
      resolvedContract = String(symbol || '').toUpperCase().includes('XAG')
        ? XAG_DEFAULT_CONTRACT_SIZE
        : XAU_DEFAULT_CONTRACT_SIZE
    }
  }

  const pipValuePerStdLot = pipPrice * resolvedContract
  return {
    pipPrice,
    pipValuePerStdLot,
    pipValuePerMiniLot: pipValuePerStdLot * 0.1,
    pipValuePerMicroLot: pipValuePerStdLot * 0.01,
    contractSize: resolvedContract,
    quoteCurrency,
    class: klass,
  }
}

/**
 * Convenience: pip value for an arbitrary lot size, in the symbol's quote
 * currency. Equivalent to `pipPrice × contractSize × lots`.
 */
export function pipValueForLots(quote: PipQuote, lots: number): number {
  const n = Number(lots)
  if (!Number.isFinite(n) || n <= 0) return 0
  return quote.pipValuePerStdLot * n
}
