"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MULTI_TRADE_ABS_MAX_LEGS = void 0;
exports.computeMultiTradeOrderCount = computeMultiTradeOrderCount;
/** Hard cap aligned with planner + AccountConfig preview. */
exports.MULTI_TRADE_ABS_MAX_LEGS = 500;
/**
 * Mirrors `src/lib/estimateMultiTradeOrders.ts` — preview order count for multi-trade bursts.
 */
function computeMultiTradeOrderCount(args) {
    const minLot = args.minLot ?? 0.01;
    const lotStep = args.lotStep ?? 0.01;
    const legPct = Math.max(0.1, Math.min(100, Number(args.legPercent ?? 5)));
    const manualLot = Number(args.manualLot);
    if (!Number.isFinite(manualLot) || manualLot <= 0)
        return 0;
    const FP_EPS = 1e-9;
    const toUnits = (v) => {
        if (!Number.isFinite(v) || v <= 0)
            return 0;
        return Math.max(0, Math.floor(v / lotStep + FP_EPS));
    };
    const manualUnits = toUnits(manualLot);
    const targetUnits = toUnits(manualLot * (legPct / 100));
    const minUnits = Math.max(1, Math.round(minLot / lotStep));
    if (targetUnits < minUnits || manualUnits < minUnits)
        return 1;
    const baseLegs = Math.max(1, Math.min(exports.MULTI_TRADE_ABS_MAX_LEGS, Math.floor(manualUnits / targetUnits)));
    const remainderUnits = manualUnits - baseLegs * targetUnits;
    if (args.rangeTrading
        && Number.isFinite(args.rangeStepPips) && (args.rangeStepPips ?? 0) > 0
        && Number.isFinite(args.rangeDistancePips) && (args.rangeDistancePips ?? 0) > 0) {
        const pct = Math.max(0, Math.min(100, Number(args.rangePercent ?? 0)));
        const pending = Math.max(0, Math.round((baseLegs * pct) / 100));
        const immediate = Math.max(0, baseLegs - pending);
        return Math.min(exports.MULTI_TRADE_ABS_MAX_LEGS, immediate + pending);
    }
    const extraRemainderLeg = remainderUnits >= minUnits && baseLegs < exports.MULTI_TRADE_ABS_MAX_LEGS;
    return Math.min(exports.MULTI_TRADE_ABS_MAX_LEGS, baseLegs + (extraRemainderLeg ? 1 : 0));
}
