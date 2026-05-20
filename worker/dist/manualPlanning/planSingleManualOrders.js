"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planSingleManualOrders = planSingleManualOrders;
const partialTpSchedule_1 = require("./partialTpSchedule");
const tpBucketDistribution_1 = require("./tpBucketDistribution");
function planSingleManualOrders(args) {
    const { orderBase, expirationFields, strictEntry, manualLot, finalSl, finalTps, manual, ctx, delay_ms, entryAnchor, isBuy, pip, pipQuote, roundPrice, fallbackReason, } = args;
    const { bucketRows } = (0, tpBucketDistribution_1.resolveTpBucketRows)(finalTps, manual.tp_lots);
    const partialPlan = (0, partialTpSchedule_1.planSinglePartialTps)({
        manualLot,
        minLot: Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01,
        lotStep: Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01,
        finalTps,
        bucketRows,
    });
    const brokerTp = partialPlan.brokerTp
        ?? (finalTps.length >= 2 ? (finalTps[finalTps.length - 1] ?? null) : (finalTps[0] ?? null));
    const combinedFallback = fallbackReason ?? partialPlan.fallbackReason;
    return {
        orders: [{
                ...orderBase,
                volume: manualLot,
                stoploss: roundPrice(finalSl),
                takeprofit: roundPrice(brokerTp),
                ...expirationFields,
            }],
        delay_ms,
        anchor: { source: entryAnchor != null ? 'signal' : 'unknown', value: entryAnchor },
        pip,
        pipQuote,
        isBuy,
        ...(strictEntry ? { strictEntry } : {}),
        ...(combinedFallback ? { fallback_reason: combinedFallback } : {}),
        ...(partialPlan.partials.length > 0 ? { partialTps: partialPlan.partials } : {}),
    };
}
