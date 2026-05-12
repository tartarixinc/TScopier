/**
 * Frontend mirror of `worker/src/pipCalculator.ts`.
 *
 * Kept in sync by hand. If you change the calculator conventions, update
 * both files in the same commit.
 */

import { classifySymbol, type SymbolClass } from './pipMath'

export interface PipQuote {
  pipPrice: number
  pipValuePerStdLot: number
  pipValuePerMiniLot: number
  pipValuePerMicroLot: number
  contractSize: number
  quoteCurrency: string | null
  class: SymbolClass
}

const FX_DEFAULT_CONTRACT_SIZE = 100_000
const XAU_DEFAULT_CONTRACT_SIZE = 100
const XAG_DEFAULT_CONTRACT_SIZE = 5_000
const INDEX_DEFAULT_CONTRACT_SIZE = 1
const CRYPTO_DEFAULT_CONTRACT_SIZE = 1
const ENERGY_DEFAULT_CONTRACT_SIZE = 1_000
const OTHER_DEFAULT_CONTRACT_SIZE = 1

function inferQuoteCurrency(symbol: string, klass: SymbolClass): string | null {
  if (klass !== 'fx_major' && klass !== 'fx_jpy' && klass !== 'metal') return null
  const upper = String(symbol || '').toUpperCase()
  const stripped = upper.replace(/[^A-Z].*$/, '')
  if (stripped.length < 6) return null
  return stripped.slice(-3)
}

function resolveContractSize(klass: SymbolClass, brokerSize: number | null | undefined): number {
  const n = Number(brokerSize)
  if (Number.isFinite(n) && n > 0) return n
  switch (klass) {
    case 'fx_major':
    case 'fx_jpy':
      return FX_DEFAULT_CONTRACT_SIZE
    case 'metal':
      return XAU_DEFAULT_CONTRACT_SIZE
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

function pipPriceFor(symbol: string, klass: SymbolClass, point: number, digits: number): number {
  const d = Number.isFinite(digits) ? Math.max(0, Math.floor(digits)) : 5
  if (klass === 'fx_major' || klass === 'fx_jpy') {
    return d === 3 || d === 5 ? point * 10 : point
  }
  if (klass === 'metal') {
    const upper = String(symbol || '').toUpperCase()
    const floor = upper.includes('XAG') ? 0.01 : 0.10
    return Math.max(point * 10, floor)
  }
  if (klass === 'index') {
    return Math.max(point * 10, 1)
  }
  return point * 10
}

export function pipCalculator(
  symbol: string,
  point: number,
  digits: number,
  contractSize?: number | null,
): PipQuote {
  const klass = classifySymbol(symbol)
  const quoteCurrency = inferQuoteCurrency(symbol, klass)

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

export function pipValueForLots(quote: PipQuote, lots: number): number {
  const n = Number(lots)
  if (!Number.isFinite(n) || n <= 0) return 0
  return quote.pipValuePerStdLot * n
}
