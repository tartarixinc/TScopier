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
  /**
   * Computed ladder span (`pending × stepPips`). When the user-set
   * `range.distancePips` differs, this is the actual reach the planner will
   * use — exposed so the UI can surface the discrepancy as an advisory.
   * Populated only when range.enabled.
   */
  effectiveDistancePips?: number
}

/**
 * Preview how many orders Multi Trades will open for a given total lot and per-leg %.
 * Uses conservative broker defaults (minLot / lotStep 0.01) when the real symbol is unknown.
 * At execution time the worker uses live SymbolParams — the live count can differ slightly.
 *
 * When `range.enabled`, returns the immediate/pending split mirroring the planner's
 * `reservedLegs = round(baseLegs * percent / 100)` logic. In range mode no remainder
 * leg is emitted, so `totalOrders = immediate + pending`.
 *
 * Preview-only: multi-trade sizing at execution uses **Fixed Lot** from settings
 * (signal-parsed telegram lots are ignored in multi-trade mode so counts match UI).
 *
 * **Step does NOT affect the count.** The pending count is purely
 * `round(baseLegs × percent / 100)`. The `range.stepPips` is the pip spacing
 * the planner will use to place each pending; `range.distancePips` is the
 * advisory target span the user expects the ladder to reach (computed as
 * `pendingCount × stepPips`). Neither caps the pending count anymore.
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
    // Pending count is fixed by range_percent × baseLegs. Step changes
    // affect spacing only — not how many pendings the planner emits.
    // (Previously this was further capped by floor(distance / step), which
    // meant raising the step shrank the Total Open Trades count — see UX
    // feedback from May 12.)
    const pending = Math.max(0, Math.round((baseLegs * pct) / 100))
    const immediate = Math.max(0, baseLegs - pending)
    const total = Math.min(MULTI_TRADE_ABS_MAX_LEGS, immediate + pending)
    return {
      baseLegs,
      extraRemainderLeg: false,
      totalOrders: total,
      fallsBackSingle: false,
      immediate,
      pending,
      effectiveDistancePips: pending * range.stepPips,
    }
  }

  const extraRemainderLeg = remainderUnits >= minUnits && baseLegs < MULTI_TRADE_ABS_MAX_LEGS
  const totalOrders = Math.min(MULTI_TRADE_ABS_MAX_LEGS, baseLegs + (extraRemainderLeg ? 1 : 0))
  return { baseLegs, extraRemainderLeg, totalOrders, fallsBackSingle: false }
}
