/** Hard cap aligned with worker/src/manualPlanner.ts */
export const MULTI_TRADE_ABS_MAX_LEGS = 500

export interface EstimateMultiTradeOrderRange {
  enabled: boolean
  percent: number
  stepPips: number
  distancePips: number
}

export interface EstimateMultiTradeOrderResult {
  baseLegs: number
  extraRemainderLeg: boolean
  totalOrders: number
  fallsBackSingle: boolean
  /** Populated only when range.enabled. */
  immediate?: number
  /** Populated only when range.enabled. */
  pending?: number
  /** Populated only when range.enabled: pending was capped by distance/step. */
  pendingCapped?: boolean
}

/**
 * Preview how many orders Multi Trades will open for a given total lot and per-leg %.
 * Uses conservative broker defaults (minLot / lotStep 0.01) when the real symbol is unknown.
 * At execution time the worker uses live SymbolParams — the live count can differ slightly.
 *
 * When `range.enabled`, returns the immediate/pending split mirroring the planner's
 * `reservedLegs = round(baseLegs * percent / 100)` and `pending = min(reserved, floor(distance / step))`
 * logic. In range mode no remainder leg is emitted, so `totalOrders = immediate + pending`.
 */
export function estimateMultiTradeOrderCount(args: {
  manualLot: number
  legPercent: number
  minLot?: number
  lotStep?: number
  range?: EstimateMultiTradeOrderRange
}): EstimateMultiTradeOrderResult {
  const minLot = args.minLot ?? 0.01
  const lotStep = args.lotStep ?? 0.01
  const legPct = Math.max(0.1, Math.min(100, Number(args.legPercent ?? 5)))
  const manualLot = Number(args.manualLot)
  if (!Number.isFinite(manualLot) || manualLot <= 0) {
    return { baseLegs: 0, extraRemainderLeg: false, totalOrders: 0, fallsBackSingle: true }
  }

  const FP_EPS = 1e-9
  const toUnits = (v: number): number => {
    if (!Number.isFinite(v) || v <= 0) return 0
    return Math.max(0, Math.floor(v / lotStep + FP_EPS))
  }
  const manualUnits = toUnits(manualLot)
  const targetUnits = toUnits(manualLot * (legPct / 100))
  const minUnits = Math.max(1, Math.round(minLot / lotStep))

  if (targetUnits < minUnits) {
    return { baseLegs: 1, extraRemainderLeg: false, totalOrders: 1, fallsBackSingle: true }
  }
  if (manualUnits < minUnits) {
    return { baseLegs: 0, extraRemainderLeg: false, totalOrders: 0, fallsBackSingle: true }
  }

  const baseLegs = Math.max(1, Math.min(MULTI_TRADE_ABS_MAX_LEGS, Math.floor(manualUnits / targetUnits)))
  const remainderUnits = manualUnits - baseLegs * targetUnits

  const range = args.range
  const rangeValid = !!(range
    && range.enabled
    && Number.isFinite(range.percent)
    && Number.isFinite(range.stepPips) && range.stepPips > 0
    && Number.isFinite(range.distancePips) && range.distancePips > 0)

  if (rangeValid && range) {
    const pct = Math.max(0, Math.min(100, Number(range.percent)))
    const reserved = Math.round((baseLegs * pct) / 100)
    const maxByDistance = Math.floor(range.distancePips / range.stepPips)
    const pending = Math.max(0, Math.min(reserved, maxByDistance))
    const immediate = Math.max(0, baseLegs - reserved)
    const total = Math.min(MULTI_TRADE_ABS_MAX_LEGS, immediate + pending)
    return {
      baseLegs,
      extraRemainderLeg: false,
      totalOrders: total,
      fallsBackSingle: false,
      immediate,
      pending,
      pendingCapped: pending < reserved,
    }
  }

  const extraRemainderLeg = remainderUnits >= minUnits && baseLegs < MULTI_TRADE_ABS_MAX_LEGS
  const totalOrders = Math.min(MULTI_TRADE_ABS_MAX_LEGS, baseLegs + (extraRemainderLeg ? 1 : 0))
  return { baseLegs, extraRemainderLeg, totalOrders, fallsBackSingle: false }
}
