/**
 * Canonical signal pip size — shared by backtest P/L and trade-config pip fields.
 * Mirror of `src/lib/signalPip.ts`.
 */

import { classifySymbol } from './pipMath'

const METAL_ALIASES: Record<string, string> = {
  GOLD: 'XAUUSD',
  XAU: 'XAUUSD',
  XAG: 'XAGUSD',
  SILVER: 'XAGUSD',
}

export function normalizeSignalSymbol(userSymbol: string): string {
  const raw = String(userSymbol ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
  if (METAL_ALIASES[raw]) return METAL_ALIASES[raw]
  if (raw.length >= 6) return raw.slice(0, 6)
  if (raw === 'XAU') return 'XAUUSD'
  if (raw === 'XAG') return 'XAGUSD'
  return raw
}

function metalPipMultiplier(base: string): number {
  if (base === 'XAU' || base === 'XPT' || base === 'XPD') return 10
  if (base === 'XAG') return 10
  return 100
}

export function getPipMultiplierForSymbol(userSymbol: string): number {
  const pair = normalizeSignalSymbol(userSymbol)
  if (pair.length >= 6) {
    const base = pair.slice(0, 3)
    const quote = pair.slice(3, 6)
    if (base === 'XAU' || base === 'XAG' || base === 'XPT' || base === 'XPD') return metalPipMultiplier(base)
    // Crypto pairs are 2-decimal instruments (BTCUSD pip = 0.01), matching
    // classifySymbol — the old 6-letter shortcut wrongly gave them forex pips.
    if (classifySymbol(userSymbol) === 'crypto') return 100
    if (quote === 'JPY') return 100
    return 10_000
  }

  const klass = classifySymbol(userSymbol)
  switch (klass) {
    case 'fx_jpy':
      return 100
    case 'fx_major':
      return 10_000
    case 'metal':
      return 10
    case 'index':
    case 'synthetic':
      return 1
    case 'crypto':
    case 'energy':
      return 100
    default:
      return 10_000
  }
}

export function signalPipPrice(symbol: string): number {
  const mult = getPipMultiplierForSymbol(symbol)
  return mult > 0 ? 1 / mult : 0.0001
}
