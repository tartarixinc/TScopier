import { resolveMultiTradeTargetUnits } from './multiTradeLegUnits'

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
  /** Reserved pending count from range_percent (Total Open Trades preview). */
  pending?: number
  /** Pending legs actually layered after range_distance depth cap. */
  activePending?: number
  /**
   * Ladder span in pips: activePending × stepPips, capped by range.distancePips.
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
 * **Step does NOT affect the reserved pending count** (range_percent drives Total Open
 * Trades). Step sets pip spacing; range_distance caps depth via
 * `activePending = min(pending, floor(distance / step))`.
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

  const { manualUnits, targetUnits, minUnits } = resolveMultiTradeTargetUnits({
    manualLot,
    legPercent: legPct,
    minLot,
    lotStep,
  })

  if (manualUnits < minUnits) {
    return { baseLegs: 0, extraRemainderLeg: false, totalOrders: 0, fallsBackSingle: true }
  }
  if (targetUnits < minUnits) {
    return { baseLegs: 1, extraRemainderLeg: false, totalOrders: 1, fallsBackSingle: true }
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
    const pending = Math.max(0, Math.round((baseLegs * pct) / 100))
    const immediate = Math.max(0, baseLegs - pending)
    const maxStepIdx = Math.max(0, Math.floor(range.distancePips / range.stepPips))
    const activePending = Math.min(pending, maxStepIdx)
    const total = Math.min(MULTI_TRADE_ABS_MAX_LEGS, immediate + pending)
    const rawSpan = activePending * range.stepPips
    return {
      baseLegs,
      extraRemainderLeg: false,
      totalOrders: total,
      fallsBackSingle: false,
      immediate,
      pending,
      activePending,
      effectiveDistancePips: Math.min(rawSpan, range.distancePips),
    }
  }

  const extraRemainderLeg = remainderUnits >= minUnits && baseLegs < MULTI_TRADE_ABS_MAX_LEGS
  const totalOrders = Math.min(MULTI_TRADE_ABS_MAX_LEGS, baseLegs + (extraRemainderLeg ? 1 : 0))
  return { baseLegs, extraRemainderLeg, totalOrders, fallsBackSingle: false }
}

export type MultiTradeTotalOpenTradesLabels = {
  fallbackSingle: string
  lotsXTrades: string
  lotsXTradesLayered: string
}

/** User-facing Total Open Trades line, e.g. `0.05 lots x 20 trades (10 instant + 10 for layering)`. */
export function formatMultiTradeTotalOpenTradesPreview(
  perLegLot: number | null,
  preview: EstimateMultiTradeOrderResult,
  labels: MultiTradeTotalOpenTradesLabels,
  formatLot: (lot: number) => string = n => (Number.isFinite(n) && n > 0 ? n.toFixed(2) : '—'),
): string {
  const lot = perLegLot != null && perLegLot > 0 ? formatLot(perLegLot) : '—'
  if (preview.fallsBackSingle || preview.totalOrders <= 0) {
    return labels.fallbackSingle.replace(/\{lot\}/g, lot)
  }
  const total = String(preview.totalOrders)
  if (preview.immediate != null && preview.pending != null) {
    return labels.lotsXTradesLayered
      .replace(/\{lot\}/g, lot)
      .replace(/\{total\}/g, total)
      .replace(/\{immediate\}/g, String(preview.immediate))
      .replace(/\{pending\}/g, String(preview.pending))
  }
  return labels.lotsXTrades
    .replace(/\{lot\}/g, lot)
    .replace(/\{total\}/g, total)
}
