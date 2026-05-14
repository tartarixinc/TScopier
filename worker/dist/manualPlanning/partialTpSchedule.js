"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planSinglePartialTps = planSinglePartialTps;
/**
 * Build the per-TP partial close schedule for a `trade_style === 'single'`
 * trade.
 *
 * Rules:
 *   - When `finalTps.length >= 2` AND there are enabled bucket rows, the
 *     broker TP becomes the LAST bucket-paired TP (so the trade rides
 *     to its deepest target) and the EARLIER buckets emit partials.
 *   - When `finalTps.length < 2` OR no enabled bucket rows, partials don't
 *     apply. With **two or more** TPs and no buckets, the broker TP is the
 *     **last** TP (deepest target). With a single TP, broker TP is that TP.
 *   - `closeLots` is `floor(manualLot × percent / 100 / lotStep) × lotStep`
 *     and is dropped when the result is below `minLot`. We never close
 *     more than `manualLot - minLot` across all partials so the last
 *     slice that rides to broker TP is always >= `minLot` (otherwise the
 *     final lot would round to 0 and the broker TP becomes a no-op).
 */
function planSinglePartialTps(args) {
    const { manualLot, minLot, lotStep, finalTps, bucketRows } = args;
    if (!Number.isFinite(manualLot) || manualLot <= 0) {
        return { brokerTp: null, partials: [], fallbackReason: 'partial_tp_invalid_lot' };
    }
    if (!Array.isArray(finalTps) || finalTps.length === 0) {
        return { brokerTp: null, partials: [], fallbackReason: 'partial_tp_invalid_lot' };
    }
    if (finalTps.length < 2) {
        return { brokerTp: finalTps[0] ?? null, partials: [] };
    }
    if (!bucketRows.length) {
        const brokerTp = finalTps[finalTps.length - 1] ?? null;
        return { brokerTp, partials: [] };
    }
    const bucketCount = Math.min(bucketRows.length, finalTps.length);
    const pairedTps = finalTps.slice(0, bucketCount);
    const pairedBuckets = bucketRows.slice(0, bucketCount);
    const brokerTp = pairedTps[bucketCount - 1] ?? null;
    if (bucketCount < 2 || brokerTp == null) {
        return { brokerTp, partials: [] };
    }
    const FP_EPS = 1e-9;
    const toUnits = (v) => {
        if (!Number.isFinite(v) || v <= 0)
            return 0;
        return Math.max(0, Math.floor(v / lotStep + FP_EPS));
    };
    const unitsToLot = (u) => Number((u * lotStep).toFixed(8));
    const manualUnits = toUnits(manualLot);
    const minUnits = Math.max(1, Math.round(minLot / lotStep));
    const usableUnits = Math.max(0, manualUnits - minUnits);
    let remainingUnits = usableUnits;
    const partials = [];
    let fallbackReason;
    for (let i = 0; i < bucketCount - 1; i++) {
        const tp = pairedTps[i];
        if (tp == null || !Number.isFinite(tp) || tp <= 0)
            continue;
        const pctRaw = Number(pairedBuckets[i]?.percent);
        const pct = Number.isFinite(pctRaw) && pctRaw > 0 ? Math.min(100, pctRaw) : 0;
        if (pct <= 0)
            continue;
        let units = toUnits(manualLot * (pct / 100));
        if (units < minUnits) {
            fallbackReason = fallbackReason ?? 'partial_tp_below_min_lot';
            continue;
        }
        if (units > remainingUnits) {
            units = remainingUnits;
            fallbackReason = fallbackReason ?? 'partial_tp_capped_remainder';
            if (units < minUnits)
                continue;
        }
        remainingUnits -= units;
        partials.push({
            tpIdx: i + 1,
            triggerPrice: tp,
            closeLots: unitsToLot(units),
            percent: pct,
        });
        if (remainingUnits < minUnits) {
            break;
        }
    }
    return { brokerTp, partials, fallbackReason };
}
