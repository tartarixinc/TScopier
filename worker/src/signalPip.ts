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

export function getPipMultiplierForSymbol(userSymbol: string): number {
  const pair = normalizeSignalSymbol(userSymbol)
  if (pair.length >= 6) {
    const base = pair.slice(0, 3)
    const quote = pair.slice(3, 6)
    if (base === 'XAU' || base === 'XAG' || base === 'XPT' || base === 'XPD') return 10
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

export function roundSignalPips(pips: number): number {
  return Math.round(pips * 100) / 100
}

export function priceDeltaToPips(delta: number, symbol: string): number {
  const pip = signalPipPrice(symbol)
  if (!Number.isFinite(pip) || pip <= 0 || !Number.isFinite(delta)) return 0
  return roundSignalPips(Math.abs(delta) / pip)
}

export function pipsToPriceOffset(pips: number, symbol: string): number {
  if (!Number.isFinite(pips)) return 0
  return pips * signalPipPrice(symbol)
}

function sortTpPrices(direction: string, tpLevels: number[]): number[] {
  return [...tpLevels].sort((a, b) =>
    direction === 'buy' ? a - b : b - a,
  )
}

export function computePipsFromSignalOutcome(input: {
  symbol: string
  direction: string
  entry: number
  sl: number | null
  tpLevels: number[]
  outcome: string
  tpsHit: number
}): number | null {
  const { symbol, direction, entry, sl, tpLevels, outcome, tpsHit } = input
  if (!(entry > 0)) return null
  if (outcome === 'skipped' || outcome === 'no_data' || outcome === 'open') return null

  const mult = getPipMultiplierForSymbol(symbol)
  const sortedTPs = sortTpPrices(direction, tpLevels)

  if (outcome === 'all_tp_hit' && sortedTPs.length > 0) {
    const highestTP = sortedTPs[sortedTPs.length - 1]!
    return roundSignalPips(Math.abs(highestTP - entry) * mult)
  }

  if (
    (outcome === 'tp1_then_sl' || outcome === 'tp_then_be')
    && tpsHit > 0
    && sl != null
    && Number.isFinite(sl)
  ) {
    const lastHitTPPrice = sortedTPs[tpsHit - 1]
    if (lastHitTPPrice == null || !Number.isFinite(lastHitTPPrice)) return null
    const tpPips = Math.abs(lastHitTPPrice - entry) * mult
    const slPips = Math.abs(sl - entry) * mult
    return roundSignalPips(tpPips - slPips)
  }

  if (outcome === 'breakeven') return 0

  if (outcome === 'sl_before_tp' && sl != null && Number.isFinite(sl)) {
    return roundSignalPips(-(Math.abs(sl - entry) * mult))
  }

  return null
}
