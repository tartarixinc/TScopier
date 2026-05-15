/** Manual trailing-stop settings (snapshot on trade open). */
export interface TrailingStopConfig {
  startPips: number
  stepPips: number
  distancePips: number
}

export interface TrailingStopInput {
  isBuy: boolean
  entryPrice: number
  currentSl: number | null
  trailPeak: number
  bid: number
  ask: number
  pipPrice: number
  digits: number
  config: TrailingStopConfig
}

export interface TrailingStopResult {
  newPeak: number
  newSl: number
  profitPips: number
}

function roundPrice(v: number, digits: number): number {
  if (!Number.isFinite(v)) return v
  return Number(v.toFixed(digits))
}

function positivePips(v: number, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function normalizeTrailingConfig(raw: {
  trailing_start_pips?: number
  trailing_step_pips?: number
  trailing_distance_pips?: number
}): TrailingStopConfig {
  return {
    startPips: positivePips(raw.trailing_start_pips ?? 0, 20),
    stepPips: positivePips(raw.trailing_step_pips ?? 0, 5),
    distancePips: positivePips(raw.trailing_distance_pips ?? 0, 10),
  }
}

/** Whether manual settings enable trailing for single-trade mode only. */
export function isSingleTradeTrailingEnabled(manual: {
  trade_style?: string
  trailing_enabled?: boolean
}): boolean {
  if (manual.trailing_enabled !== true) return false
  return (manual.trade_style ?? 'single') !== 'multi'
}

/** DB columns to set on trades.insert when trailing is active. */
export function trailingTradeRowSnapshot(
  manual: {
    trade_style?: string
    trailing_enabled?: boolean
    trailing_start_pips?: number
    trailing_step_pips?: number
    trailing_distance_pips?: number
  },
  entryPrice: number | null | undefined,
  sl: number | null | undefined,
): Record<string, number | null> {
  if (!isSingleTradeTrailingEnabled(manual)) return {}
  const entry = Number(entryPrice)
  if (!Number.isFinite(entry) || entry <= 0) return {}
  const cfg = normalizeTrailingConfig(manual)
  const slNum = sl != null && Number.isFinite(Number(sl)) && Number(sl) > 0 ? Number(sl) : null
  return {
    trail_peak_price: entry,
    trail_last_sl: slNum,
    trail_start_pips: cfg.startPips,
    trail_step_pips: cfg.stepPips,
    trail_distance_pips: cfg.distancePips,
  }
}

/**
 * Compute the next trailing SL if profit has reached start and price moved
 * enough since the last SL update. Returns null when no change is needed.
 */
export function computeTrailingStopUpdate(input: TrailingStopInput): TrailingStopResult | null {
  const { isBuy, entryPrice, pipPrice, digits, config, bid, ask } = input
  if (!Number.isFinite(pipPrice) || pipPrice <= 0) return null
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null

  const favorable = isBuy ? bid : ask
  if (!Number.isFinite(favorable) || favorable <= 0) return null

  const profitPips = isBuy
    ? (favorable - entryPrice) / pipPrice
    : (entryPrice - favorable) / pipPrice
  if (profitPips < config.startPips) return null

  const newPeak = isBuy
    ? Math.max(input.trailPeak, favorable)
    : Math.min(input.trailPeak, favorable)

  const dist = config.distancePips * pipPrice
  const rawCandidate = isBuy ? newPeak - dist : newPeak + dist
  const candidateSl = roundPrice(rawCandidate, digits)
  if (!Number.isFinite(candidateSl) || candidateSl <= 0) return null

  const currentSl = input.currentSl != null && Number.isFinite(input.currentSl) && input.currentSl > 0
    ? input.currentSl
    : null

  if (isBuy) {
    if (candidateSl <= entryPrice) return null
    if (currentSl != null && candidateSl <= currentSl) return null
    if (currentSl != null) {
      const improvePips = (candidateSl - currentSl) / pipPrice
      if (improvePips < config.stepPips) return null
    }
  } else {
    if (candidateSl >= entryPrice) return null
    if (currentSl != null && candidateSl >= currentSl) return null
    if (currentSl != null) {
      const improvePips = (currentSl - candidateSl) / pipPrice
      if (improvePips < config.stepPips) return null
    }
  }

  return { newPeak, newSl: candidateSl, profitPips }
}
