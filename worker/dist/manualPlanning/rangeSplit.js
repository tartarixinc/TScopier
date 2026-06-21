"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planRangeSplit = planRangeSplit;
/**
 * Decide how many of the planned legs go out as immediates vs. range pendings.
 * Pure function so the split can be unit-tested and reused by the UI estimator
 * down the line.
 *
 * **Step does NOT shrink the reserved pending count** (range_percent drives that
 * for Total Open Trades preview stability). The `step` is the pip spacing between
 * consecutive ladder rungs. `distPips` caps how deep the ladder may go:
 * `maxStepIdx = floor(distPips / effectiveStepPips)`; only stepIdx 1..maxStepIdx
 * are materialized as virtual pendings.
 */
function planRangeSplit(args) {
    const { totalLegs, baseIsPendingSignal, rangeOn, rangePct, stepPips, distPips, pip, minStepPriceUnits, hasSignalAnchor } = args;
    const safe = (n) => Number.isFinite(n) && n > 0;
    const baseResult = {
        immediateLegs: totalLegs,
        pendingLegs: 0,
        activePendingLegs: 0,
        maxStepIdx: 0,
        effectiveStepPips: stepPips,
        stepPriceOffset: 0,
    };
    if (!rangeOn)
        return baseResult;
    if (baseIsPendingSignal)
        return { ...baseResult, fallbackReason: 'range_trading_skip_pending_signal' };
    if (!safe(stepPips) || !safe(distPips)) {
        return { ...baseResult, fallbackReason: 'range_trading_invalid' };
    }
    let effectiveStepPips = stepPips;
    let fallbackReason;
    if (minStepPriceUnits > 0 && pip > 0 && stepPips * pip < minStepPriceUnits) {
        effectiveStepPips = Math.max(stepPips, Math.ceil(minStepPriceUnits / pip));
        fallbackReason = 'range_trading_step_auto_expanded';
    }
    const stepPriceOffset = effectiveStepPips * pip;
    const maxStepIdx = Math.max(0, Math.floor(distPips / effectiveStepPips));
    const reservedLegs = Math.max(0, Math.round((totalLegs * rangePct) / 100));
    if (reservedLegs <= 0) {
        return { ...baseResult, effectiveStepPips, stepPriceOffset, maxStepIdx, fallbackReason };
    }
    const activePendingLegs = Math.min(reservedLegs, maxStepIdx);
    if (activePendingLegs <= 0 && reservedLegs > 0) {
        fallbackReason = fallbackReason ?? 'range_trading_distance_capped';
    }
    else if (activePendingLegs < reservedLegs) {
        fallbackReason = fallbackReason ?? 'range_trading_distance_capped';
    }
    const immediateLegs = Math.max(0, totalLegs - reservedLegs);
    if (!hasSignalAnchor && immediateLegs === 0) {
        fallbackReason = 'range_trading_anchor_runtime_only';
    }
    return {
        immediateLegs,
        pendingLegs: reservedLegs,
        activePendingLegs,
        maxStepIdx,
        effectiveStepPips,
        stepPriceOffset,
        fallbackReason,
    };
}
