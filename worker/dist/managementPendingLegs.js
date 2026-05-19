"use strict";
/**
 * Apply channel / basket management instructions to virtual range_pending_legs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pendingLegsToCancelScopes = pendingLegsToCancelScopes;
exports.loadRangePendingLegsInMgmtScope = loadRangePendingLegsInMgmtScope;
exports.updateRangePendingLegsForManagement = updateRangePendingLegsForManagement;
const basketModFollowUp_1 = require("./basketModFollowUp");
const tpBucketDistribution_1 = require("./manualPlanning/tpBucketDistribution");
function sanitizeLevel(v) {
    const n = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
function pendingLegsToCancelScopes(legs) {
    const uniq = new Map();
    for (const leg of legs) {
        const key = `${leg.signal_id}|${leg.broker_account_id}|${leg.symbol}`;
        uniq.set(key, {
            signalId: leg.signal_id,
            brokerAccountId: leg.broker_account_id,
            symbol: leg.symbol,
        });
    }
    return [...uniq.values()];
}
async function loadRangePendingLegsInMgmtScope(supabase, args) {
    const { userId, brokerAccountIds, channelId, basketSignalId, symbolFilter } = args;
    if (!brokerAccountIds.length)
        return [];
    let signalIds = null;
    if (basketSignalId) {
        signalIds = [basketSignalId];
    }
    else if (channelId) {
        const { data: sigs } = await supabase
            .from('signals')
            .select('id')
            .eq('user_id', userId)
            .eq('channel_id', channelId)
            .limit(5000);
        signalIds = (sigs ?? []).map((r) => r.id);
        if (!signalIds.length)
            return [];
    }
    let query = supabase
        .from('range_pending_legs')
        .select('id,signal_id,broker_account_id,symbol,step_idx,is_buy,anchor_price,stoploss,takeprofit,cwe_close_price,status')
        .eq('user_id', userId)
        .in('broker_account_id', brokerAccountIds)
        .in('status', ['pending', 'claimed'])
        .limit(500);
    if (signalIds) {
        query = query.in('signal_id', signalIds);
    }
    const { data, error } = await query;
    if (error) {
        console.warn(`[managementPendingLegs] load failed: ${error.message}`);
        return [];
    }
    let legs = (data ?? []);
    if (symbolFilter?.trim()) {
        legs = legs.filter(l => (0, basketModFollowUp_1.symbolsCompatibleForBasket)(symbolFilter, l.symbol));
    }
    return legs;
}
async function updateRangePendingLegsForManagement(args) {
    const { supabase, parsed, pendingLegs, openTrades, tpLotsByBroker, action, hasNewSl, hasNewTp, parsedTpLevels, } = args;
    if (!pendingLegs.length)
        return 0;
    const act = action.toLowerCase();
    if (act !== 'modify' && act !== 'breakeven' && act !== 'partial_breakeven')
        return 0;
    const openByBasket = new Map();
    for (const tr of openTrades) {
        const key = `${tr.signal_id}|${tr.broker_account_id}`;
        const list = openByBasket.get(key) ?? [];
        list.push(tr);
        openByBasket.set(key, list);
    }
    let updated = 0;
    for (const leg of pendingLegs) {
        const basketKey = `${leg.signal_id}|${leg.broker_account_id}`;
        const brokerOpen = openByBasket.get(basketKey) ?? [];
        const openLegCount = Math.max(brokerOpen.length, leg.step_idx + 1);
        const tpLots = tpLotsByBroker.get(leg.broker_account_id);
        let stoploss = leg.stoploss;
        let takeprofit = leg.takeprofit;
        if (act === 'breakeven' || act === 'partial_breakeven') {
            const anchor = sanitizeLevel(leg.anchor_price);
            if (anchor > 0)
                stoploss = anchor;
        }
        else if (act === 'modify') {
            if (hasNewSl)
                stoploss = parsed.sl;
            if (hasNewTp && leg.cwe_close_price == null) {
                const distributed = (0, tpBucketDistribution_1.takeProfitForLegIndex)({
                    legIndex: leg.step_idx,
                    openLegCount,
                    finalTps: parsedTpLevels,
                    tpLots,
                });
                takeprofit = distributed > 0 ? distributed : parsedTpLevels[parsedTpLevels.length - 1] ?? leg.takeprofit;
            }
        }
        const patch = {
            stoploss,
            takeprofit: leg.cwe_close_price != null ? null : takeprofit,
        };
        const { error } = await supabase
            .from('range_pending_legs')
            .update(patch)
            .eq('id', leg.id)
            .in('status', ['pending', 'claimed']);
        if (!error)
            updated++;
    }
    return updated;
}
