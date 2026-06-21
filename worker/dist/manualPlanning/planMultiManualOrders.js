"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planMultiManualOrders = planMultiManualOrders;
const manualSettings_1 = require("./manualSettings");
const tradeComment_1 = require("../tradeComment");
const rangeSplit_1 = require("./rangeSplit");
const tpBucketDistribution_1 = require("./tpBucketDistribution");
const multiTradeLegUnits_1 = require("./multiTradeLegUnits");
const signalEntryRange_1 = require("./signalEntryRange");
const parsedEntry_1 = require("./parsedEntry");
function planMultiManualOrders(args) {
    const { orderBase, expirationFields, strictEntry, manual, manualLot, parsed, ctx, commentPrefix, expertId, slippage, finalSl, finalTps, entryAnchor, isBuy, pip, pipQuote, delay_ms, roundPrice, minStopDist, buildSingleOrder, } = args;
    const minLot = Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01;
    const lotStep = Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01;
    const legPct = Math.max(0.1, Math.min(100, Number(manual.multi_trade_leg_percent ?? 5)));
    const ABS_MAX_LEGS = 500;
    const { manualUnits, targetUnits, minUnits } = (0, multiTradeLegUnits_1.resolveMultiTradeTargetUnits)({
        manualLot,
        legPercent: legPct,
        minLot,
        lotStep,
    });
    const targetLeg = (0, multiTradeLegUnits_1.multiTradeUnitsToLot)(targetUnits, lotStep);
    if (manualUnits < minUnits) {
        return { orders: [], skip_reason: 'lot_below_symbol_min', delay_ms };
    }
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
    const totalLegs = Math.max(1, Math.min(ABS_MAX_LEGS, Math.floor(manualUnits / targetUnits)));
    // Use the *effective* immediate op (market vs broker pending), not `opSplit`.
    // Signals with an entry used to map to BuyLimit for SL/TP geometry, but we
    // execute immediates as Buy/Sell at price 0 — virtual range legs are not
    // broker pendings on that path, so range layering must stay enabled.
    const baseIsPendingSignal = orderBase.operation.includes('Limit') || orderBase.operation.includes('Stop');
    const rangeDistance = (0, signalEntryRange_1.resolveRangeDistancePips)({ manual, parsed, pip, isBuy });
    const split = (0, rangeSplit_1.planRangeSplit)({
        totalLegs,
        baseIsPendingSignal,
        rangeOn: manual.range_trading === true,
        rangePct: Math.max(0, Math.min(100, Number(manual.range_percent ?? 0))),
        stepPips: Math.max(0, Number(manual.range_step_pips ?? 0)),
        distPips: rangeDistance.distPips,
        pip,
        minStepPriceUnits: minStopDist,
        hasSignalAnchor: entryAnchor != null,
    });
    const immediateLegs = split.immediateLegs;
    const reservedRangeLegs = split.pendingLegs;
    const effectiveRangeLegs = split.activePendingLegs;
    const stepPriceOffset = split.stepPriceOffset;
    let rangeFallbackReason = split.fallbackReason;
    const totalLegsForTp = immediateLegs + effectiveRangeLegs;
    const immediateTpPrices = (0, tpBucketDistribution_1.buildDistributedPerLegTakeProfits)({
        openLegCount: immediateLegs,
        finalTps,
        tpLots: manual.tp_lots,
    });
    const rangeTpPrices = (0, tpBucketDistribution_1.buildDistributedPerLegTakeProfits)({
        openLegCount: effectiveRangeLegs,
        finalTps,
        tpLots: manual.tp_lots,
    });
    const tpForImmediateIndex = (idx) => {
        if (finalTps.length === 0)
            return null;
        const price = immediateTpPrices[idx];
        if (typeof price === 'number' && Number.isFinite(price) && price > 0)
            return price;
        return finalTps[finalTps.length - 1] ?? null;
    };
    const tpForRangeIndex = (idx) => {
        if (finalTps.length === 0)
            return null;
        if (manual.range_trading === true
            && effectiveRangeLegs > 0
            && entryAnchor != null
            && entryAnchor > 0
            && stepPriceOffset > 0) {
            const projectedLegs = [];
            for (let i = 0; i < immediateLegs; i++) {
                projectedLegs.push({
                    id: `imm${i}`,
                    entryPrice: entryAnchor,
                    openedAt: `imm${String(i).padStart(4, '0')}`,
                });
            }
            for (let i = 0; i < effectiveRangeLegs; i++) {
                const stepIdx = i + 1;
                const offset = stepIdx * stepPriceOffset;
                projectedLegs.push({
                    id: `rg${stepIdx}`,
                    entryPrice: isBuy ? entryAnchor - offset : entryAnchor + offset,
                    openedAt: `rg${String(stepIdx).padStart(4, '0')}`,
                });
            }
            const projectedTp = (0, tpBucketDistribution_1.buildEntryQualityTakeProfitMap)({
                legs: projectedLegs,
                isBuy,
                slotLegCount: immediateLegs + effectiveRangeLegs,
                finalTps,
                tpLots: manual.tp_lots,
            }).get(`rg${idx + 1}`);
            if (typeof projectedTp === 'number' && projectedTp > 0)
                return projectedTp;
        }
        const price = rangeTpPrices[idx];
        if (typeof price === 'number' && Number.isFinite(price) && price > 0)
            return price;
        return finalTps[finalTps.length - 1] ?? null;
    };
    // Assign a TP to every granular leg first (preserves the tp_lots volume
    // distribution exactly), then consolidate legs sharing the same TP into at
    // most `multi_trade_max_orders` orders. The MT bridge executes OrderSends
    // serially per account (~0.5-0.7s each), so an uncapped burst of 25 legs
    // takes ~18s — consolidation keeps total volume and the per-TP volume split
    // identical while bounding placement time to a few seconds.
    const burstCapRaw = Number(manual.multi_trade_max_orders ?? ABS_MAX_LEGS);
    const burstCap = Number.isFinite(burstCapRaw) && burstCapRaw > 0
        ? Math.max(1, Math.min(ABS_MAX_LEGS, Math.floor(burstCapRaw)))
        : ABS_MAX_LEGS;
    if (burstCap < immediateLegs) {
        console.log(`[planMulti] burst cap ${burstCap} consolidates ${immediateLegs} immediate legs`
            + ` (leg%=${legPct} manualLot=${manualLot})`);
    }
    const burstGroups = [];
    for (let i = 0; i < immediateLegs; i++) {
        const tpPrice = tpForImmediateIndex(i);
        const last = burstGroups[burstGroups.length - 1];
        if (last && last.tpPrice === tpPrice)
            last.legCount += 1;
        else
            burstGroups.push({ tpPrice, legCount: 1 });
    }
    const orders = [];
    if (burstGroups.length > 0) {
        // Every distinct TP keeps at least one order; spare slots go to the
        // groups carrying the most volume so order sizes stay balanced.
        const cap = Math.max(burstGroups.length, Math.min(burstCap, immediateLegs));
        const alloc = burstGroups.map(g => ({ g, orders: 1 }));
        let used = burstGroups.length;
        while (used < cap) {
            let best = -1;
            for (let i = 0; i < alloc.length; i++) {
                if (alloc[i].orders >= alloc[i].g.legCount)
                    continue;
                if (best < 0
                    || alloc[i].g.legCount / alloc[i].orders > alloc[best].g.legCount / alloc[best].orders) {
                    best = i;
                }
            }
            if (best < 0)
                break;
            alloc[best].orders += 1;
            used += 1;
        }
        let orderNo = 0;
        for (const { g, orders: orderCount } of alloc) {
            const groupUnits = g.legCount * targetUnits;
            const baseUnits = Math.floor(groupUnits / orderCount);
            let remainder = groupUnits - baseUnits * orderCount;
            for (let k = 0; k < orderCount; k++) {
                const units = baseUnits + (remainder > 0 ? 1 : 0);
                if (remainder > 0)
                    remainder -= 1;
                if (units <= 0)
                    continue;
                orderNo += 1;
                orders.push({
                    ...orderBase,
                    volume: (0, multiTradeLegUnits_1.multiTradeUnitsToLot)(units, lotStep),
                    stoploss: roundPrice(finalSl),
                    takeprofit: roundPrice(g.tpPrice),
                    ...expirationFields,
                    comment: (0, tradeComment_1.appendOrderCommentSuffix)(commentPrefix, `:tp${orderNo}`),
                });
            }
        }
    }
    const virtualPendings = [];
    if (effectiveRangeLegs > 0) {
        const pendHours = (0, manualSettings_1.clampPendingExpiryHours)(manual.pending_expiry_hours);
        const expiryHours = pendHours > 0 ? pendHours : undefined;
        let stepIdx = 1;
        for (let i = 0; i < effectiveRangeLegs; i++) {
            const tpPrice = tpForRangeIndex(i);
            virtualPendings.push({
                stepIdx,
                stepPriceOffset,
                isBuy,
                volume: targetLeg,
                stoploss: finalSl,
                takeprofit: tpPrice,
                slippage: slippage ?? 20,
                comment: (0, tradeComment_1.appendOrderCommentSuffix)(commentPrefix, `:rg${stepIdx}.tp`),
                expertID: expertId,
                expiryHours,
            });
            stepIdx += 1;
        }
    }
    if (effectiveRangeLegs === 0) {
        const remainderUnits = manualUnits - totalLegs * targetUnits;
        if (remainderUnits >= minUnits && orders.length < ABS_MAX_LEGS) {
            const tpPrice = tpForImmediateIndex(Math.max(0, immediateLegs - 1))
                ?? tpForImmediateIndex(0);
            orders.push({
                ...orderBase,
                volume: (0, multiTradeLegUnits_1.multiTradeUnitsToLot)(remainderUnits, lotStep),
                stoploss: roundPrice(finalSl),
                takeprofit: roundPrice(tpPrice),
                ...expirationFields,
                comment: (0, tradeComment_1.appendOrderCommentSuffix)(commentPrefix, ':tp.rem'),
            });
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
        ...(manual.range_trading === true && reservedRangeLegs > 0
            ? {
                rangeLayering: {
                    rangeStepPips: Math.max(0, Number(manual.range_step_pips ?? 0)),
                    rangeDistancePips: Math.max(0, Number(manual.range_distance_pips ?? 0)),
                    effectiveStepPips: split.effectiveStepPips,
                    stepPriceOffset: split.stepPriceOffset,
                    maxStepIdx: split.maxStepIdx,
                    reservedPendingLegs: reservedRangeLegs,
                    activePendingLegs: effectiveRangeLegs,
                    ...(manual.use_signal_entry_range === true
                        ? {
                            useSignalEntryRange: true,
                            signalRangeBoundary: rangeDistance.boundary,
                            signalZoneLo: (0, parsedEntry_1.resolvedParsedEntryZone)(parsed)?.lo ?? null,
                            signalZoneHi: (0, parsedEntry_1.resolvedParsedEntryZone)(parsed)?.hi ?? null,
                            effectiveDistancePips: rangeDistance.distPips,
                        }
                        : {}),
                },
            }
            : {}),
        delay_ms,
        ...(rangeFallbackReason ? { fallback_reason: rangeFallbackReason } : {}),
    };
}
