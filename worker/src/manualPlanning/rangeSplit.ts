import type { PlanRangeSplitArgs, PlanRangeSplitResult } from './types'

/**
 * Decide how many of the planned legs go out as immediates vs. range pendings.
 * Pure function so the split can be unit-tested and reused by the UI estimator
 * down the line.
 *
 * **Step does NOT shrink the pending count.** Pending count is purely
 * `round(totalLegs × rangePct / 100)`. The `step` is the pip spacing the
 * planner uses to place each pending. `distPips` is an advisory target span
 * the user expects the ladder to reach — it's validated as > 0 so the user
 * has to set SOMETHING in range mode, but it no longer caps the count.
 */
export function planRangeSplit(args: PlanRangeSplitArgs): PlanRangeSplitResult {
  const { totalLegs, baseIsPendingSignal, rangeOn, rangePct, stepPips, distPips, pip, minStepPriceUnits, hasSignalAnchor } = args
  const safe = (n: number) => Number.isFinite(n) && n > 0
  const baseResult: PlanRangeSplitResult = {
    immediateLegs: totalLegs,
    pendingLegs: 0,
    effectiveStepPips: stepPips,
    stepPriceOffset: 0,
  }
  if (!rangeOn) return baseResult
  if (baseIsPendingSignal) return { ...baseResult, fallbackReason: 'range_trading_skip_pending_signal' }
  if (!safe(stepPips) || !safe(distPips)) {
    return { ...baseResult, fallbackReason: 'range_trading_invalid' }
  }

  let effectiveStepPips = stepPips
  let fallbackReason: string | undefined
  if (minStepPriceUnits > 0 && pip > 0 && stepPips * pip < minStepPriceUnits) {
    effectiveStepPips = Math.max(stepPips, Math.ceil(minStepPriceUnits / pip))
    fallbackReason = 'range_trading_step_auto_expanded'
  }
  const stepPriceOffset = effectiveStepPips * pip

  const reservedLegs = Math.max(0, Math.round((totalLegs * rangePct) / 100))
  if (reservedLegs <= 0) {
    return { ...baseResult, effectiveStepPips, stepPriceOffset, fallbackReason }
  }

  const immediateLegs = Math.max(0, totalLegs - reservedLegs)
  return {
    immediateLegs,
    pendingLegs: reservedLegs,
    effectiveStepPips,
    stepPriceOffset,
    fallbackReason: fallbackReason ?? (!hasSignalAnchor && immediateLegs === 0 ? 'range_trading_anchor_runtime_only' : undefined),
  }
}
