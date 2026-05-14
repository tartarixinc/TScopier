"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planMultiManualOrders = planMultiManualOrders;
const manualSettings_1 = require("./manualSettings");
const rangeSplit_1 = require("./rangeSplit");
function planMultiManualOrders(args) {
    const { orderBase, expirationFields, strictEntry, opSplit, manual, manualLot, ctx, commentPrefix, expertId, slippage, finalSl, finalTps, entryAnchor, isBuy, pip, pipQuote, delay_ms, roundPrice, minStopDist, buildSingleOrder, } = args;
    const minLot = Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01;
    const lotStep = Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01;
    const FP_EPS = 1e-9;
    const toUnits = (v) => {
        if (!Number.isFinite(v) || v <= 0)
            return 0;
        return Math.max(0, Math.floor(v / lotStep + FP_EPS));
    };
    const unitsToLot = (u) => Number((u * lotStep).toFixed(8));
    const legPct = Math.max(0.1, Math.min(100, Number(manual.multi_trade_leg_percent ?? 5)));
    const ABS_MAX_LEGS = 500;
    const manualUnits = toUnits(manualLot);
    const targetUnits = toUnits(manualLot * (legPct / 100));
    const minUnits = Math.max(1, Math.round(minLot / lotStep));
    if (targetUnits < minUnits) {
        return buildSingleOrder({
            orderBase,
            expirationFields,
            strictEntry,
            manualLot,
            finalSl,
            finalTps,
            manual,
            ctx,
            delay_ms,
            entryAnchor,
            isBuy,
            pip,
            pipQuote,
            roundPrice,
            fallbackReason: 'multi_trade_fallback_min_lot',
        });
    }
    if (manualUnits < minUnits) {
        return { orders: [], skip_reason: 'lot_below_symbol_min', delay_ms };
    }
    const totalLegs = Math.max(1, Math.min(ABS_MAX_LEGS, Math.floor(manualUnits / targetUnits)));
    const targetLeg = unitsToLot(targetUnits);
    const baseIsPendingSignal = opSplit.includes('Limit') || opSplit.includes('Stop');
    const split = (0, rangeSplit_1.planRangeSplit)({
        totalLegs,
        baseIsPendingSignal,
        rangeOn: manual.range_trading === true,
        rangePct: Math.max(0, Math.min(100, Number(manual.range_percent ?? 0))),
        stepPips: Math.max(0, Number(manual.range_step_pips ?? 0)),
        distPips: Math.max(0, Number(manual.range_distance_pips ?? 0)),
        pip,
        minStepPriceUnits: minStopDist,
        hasSignalAnchor: entryAnchor != null,
    });
    const immediateLegs = split.immediateLegs;
    const effectiveRangeLegs = split.pendingLegs;
    const stepPriceOffset = split.stepPriceOffset;
    const rangeFallbackReason = split.fallbackReason;
    const enabledRows = (manual.tp_lots ?? []).filter(r => r && r.enabled);
    const bucketCount = finalTps.length > 0
        ? Math.max(1, Math.min(enabledRows.length || 1, finalTps.length))
        : 1;
    const bucketRows = (enabledRows.length ? enabledRows : [{ label: 'TP1', lot: 0, percent: 100, enabled: true }])
        .slice(0, bucketCount);
    const rawWeights = bucketRows.map(r => {
        const p = Number(r.percent);
        return Number.isFinite(p) && p > 0 ? p : 0;
    });
    const weights = rawWeights.every(w => w === 0) ? bucketRows.map(() => 1) : rawWeights;
    const sumW = weights.reduce((a, b) => a + b, 0) || bucketRows.length;
    const distributeCount = (count) => {
        const out = bucketRows.map(() => 0);
        if (count <= 0 || bucketRows.length === 0)
            return out;
        for (let i = 0; i < weights.length; i++) {
            out[i] = Math.round((count * weights[i]) / sumW);
        }
        let drift = count - out.reduce((a, b) => a + b, 0);
        let idx = out.length - 1;
        let guard = out.length * 2;
        while (drift !== 0 && guard-- > 0) {
            if (drift > 0) {
                out[idx] += 1;
                drift -= 1;
            }
            else if (out[idx] > 0) {
                out[idx] -= 1;
                drift += 1;
            }
            idx = (idx - 1 + out.length) % out.length;
            if (drift < 0 && out.every(c => c === 0))
                break;
        }
        return out;
    };
    const tpForBucket = (b) => {
        if (finalTps.length === 0)
            return null;
        return finalTps[b] ?? finalTps[finalTps.length - 1] ?? null;
    };
    const immediateCounts = distributeCount(immediateLegs);
    const rangeCounts = distributeCount(effectiveRangeLegs);
    const orders = [];
    for (let b = 0; b < bucketRows.length; b++) {
        const tpPrice = tpForBucket(b);
        for (let k = 0; k < (immediateCounts[b] ?? 0); k++) {
            orders.push({
                ...orderBase,
                volume: targetLeg,
                stoploss: roundPrice(finalSl),
                takeprofit: roundPrice(tpPrice),
                ...expirationFields,
                comment: `${commentPrefix}:tp${b + 1}.${k + 1}`,
            });
        }
    }
    const virtualPendings = [];
    if (effectiveRangeLegs > 0) {
        const pendHours = (0, manualSettings_1.clampPendingExpiryHours)(manual.pending_expiry_hours);
        const expiryHours = pendHours > 0 ? pendHours : undefined;
        let stepIdx = 1;
        for (let b = 0; b < bucketRows.length; b++) {
            const tpPrice = tpForBucket(b);
            for (let k = 0; k < (rangeCounts[b] ?? 0); k++) {
                virtualPendings.push({
                    stepIdx,
                    stepPriceOffset,
                    isBuy,
                    volume: targetLeg,
                    stoploss: finalSl,
                    takeprofit: tpPrice,
                    slippage: slippage ?? 20,
                    comment: `${commentPrefix}:rg${stepIdx}.tp${b + 1}`,
                    expertID: expertId,
                    expiryHours,
                });
                stepIdx += 1;
            }
        }
    }
    if (effectiveRangeLegs === 0) {
        const remainderUnits = manualUnits - totalLegs * targetUnits;
        if (remainderUnits >= minUnits && orders.length < ABS_MAX_LEGS) {
            const tpPrice = tpForBucket(bucketRows.length - 1);
            orders.push({
                ...orderBase,
                volume: unitsToLot(remainderUnits),
                stoploss: roundPrice(finalSl),
                takeprofit: roundPrice(tpPrice),
                ...expirationFields,
                comment: `${commentPrefix}:tp${bucketRows.length}.rem`,
            });
        }
    }
    let closeWorseEntries;
    if (effectiveRangeLegs > 0 && manual.close_worse_entries === true) {
        const cwPips = Math.max(0, Number(manual.close_worse_entries_pips ?? 0));
        if (cwPips > 0) {
            const extraPendings = Math.max(0, Math.min(effectiveRangeLegs, Math.floor(Number(manual.close_worse_extra_pendings ?? 0))));
            closeWorseEntries = {
                immediates: immediateLegs,
                extraPendings,
                pipsFromAnchor: cwPips,
            };
        }
    }
    if (orders.length === 0 && virtualPendings.length === 0) {
        return buildSingleOrder({
            orderBase,
            expirationFields,
            strictEntry,
            manualLot,
            finalSl,
            finalTps,
            manual,
            ctx,
            delay_ms,
            entryAnchor,
            isBuy,
            pip,
            pipQuote,
            roundPrice,
            fallbackReason: 'multi_trade_fallback_zero_legs',
        });
    }
    return {
        orders,
        ...(virtualPendings.length ? { virtualPendings } : {}),
        anchor: { source: entryAnchor != null ? 'signal' : 'unknown', value: entryAnchor },
        pip,
        pipQuote,
        isBuy,
        ...(strictEntry ? { strictEntry } : {}),
        ...(closeWorseEntries ? { closeWorseEntries } : {}),
        delay_ms,
        ...(rangeFallbackReason ? { fallback_reason: rangeFallbackReason } : {}),
    };
}
