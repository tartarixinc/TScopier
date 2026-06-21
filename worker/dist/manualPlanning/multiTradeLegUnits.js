"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.multiTradeToUnits = multiTradeToUnits;
exports.multiTradeUnitsToLot = multiTradeUnitsToLot;
exports.resolveMultiTradeTargetUnits = resolveMultiTradeTargetUnits;
exports.computeMinMultiTradeLegPercent = computeMinMultiTradeLegPercent;
const FP_EPS = 1e-9;
function multiTradeToUnits(v, lotStep) {
    if (!Number.isFinite(v) || v <= 0)
        return 0;
    return Math.max(0, Math.floor(v / lotStep + FP_EPS));
}
function multiTradeUnitsToLot(units, lotStep) {
    return Number((units * lotStep).toFixed(8));
}
/** Per-leg lot units for multi-trade bursts (no clamp — callers fall back to single trade when below min). */
function resolveMultiTradeTargetUnits(args) {
    const minLot = args.minLot ?? 0.01;
    const lotStep = args.lotStep ?? 0.01;
    const legPct = Math.max(0.1, Math.min(100, Number(args.legPercent ?? 5)));
    const manualUnits = multiTradeToUnits(args.manualLot, lotStep);
    const minUnits = Math.max(1, Math.round(minLot / lotStep));
    const targetUnits = multiTradeToUnits(args.manualLot * (legPct / 100), lotStep);
    return { manualUnits, targetUnits, minUnits };
}
/** Smallest leg % so each leg is at least minLot after lot-step rounding. */
function computeMinMultiTradeLegPercent(manualLot, minLot = 0.01, lotStep = 0.01) {
    if (!Number.isFinite(manualLot) || manualLot <= 0)
        return 100;
    const manualUnits = multiTradeToUnits(manualLot, lotStep);
    const minUnits = Math.max(1, Math.round(minLot / lotStep));
    if (manualUnits < minUnits)
        return 100;
    let pct = Math.max(0.1, (minUnits * lotStep / manualLot) * 100);
    for (let i = 0; i < 1000; i++) {
        if (multiTradeToUnits(manualLot * (pct / 100), lotStep) >= minUnits) {
            return Math.min(100, Math.ceil(pct * 10) / 10);
        }
        pct += 0.1;
    }
    return 100;
}
