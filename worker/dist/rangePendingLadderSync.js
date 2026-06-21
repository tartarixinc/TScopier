"use strict";
/**
 * Keep range ladder state consistent on basket SL/TP refresh — update pending rungs
 * and only insert steps not yet fired. Prevents duplicate market fires when
 * parameter signals re-plan the full 4+6 layout.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TERMINAL_RANGE_LEG_STATUSES = void 0;
exports.loadRangeLegRows = loadRangeLegRows;
exports.resolveExistingRangeLadderAnchor = resolveExistingRangeLadderAnchor;
exports.consumedStepIndices = consumedStepIndices;
exports.maxConsumedStepIndex = maxConsumedStepIndex;
exports.pendingLegStopsForBasketRefresh = pendingLegStopsForBasketRefresh;
exports.patchActiveRangePendingLegStops = patchActiveRangePendingLegStops;
exports.syncRangePendingLadderOnBasketRefresh = syncRangePendingLadderOnBasketRefresh;
exports.markRangeLegFired = markRangeLegFired;
exports.markRangeLegsExpired = markRangeLegsExpired;
const channelActiveTradeParams_1 = require("./channelActiveTradeParams");
exports.TERMINAL_RANGE_LEG_STATUSES = ['fired', 'expired', 'cancelled', 'failed'];
async function hasRangePendingTpTouchLock(supabase, scope) {
    const { count, error } = await supabase
        .from('range_pending_tp_locks')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', scope.signalId)
        .eq('broker_account_id', scope.brokerAccountId)
        .eq('symbol', scope.symbol);
    if (error) {
        console.warn(`[rangePendingLadderSync] tp-lock lookup failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${error.message}`);
        return false;
    }
    return (count ?? 0) > 0;
}
async function loadRangeLegRows(supabase, scope) {
    const { data, error } = await supabase
        .from('range_pending_legs')
        .select('id,step_idx,status,stoploss,takeprofit,cwe_close_price')
        .eq('signal_id', scope.signalId)
        .eq('broker_account_id', scope.brokerAccountId)
        .eq('symbol', scope.symbol)
        .limit(500);
    if (error) {
        console.warn(`[rangePendingLadderSync] load failed signal=${scope.signalId}: ${error.message}`);
        return [];
    }
    return (data ?? []);
}
/**
 * Anchor of the existing ladder for this basket scope (rows share one anchor from the
 * original materialization). Basket-refresh inserts MUST reuse it: re-anchoring at the
 * newest fill or live quote walks the ladder in the favorable direction and fires new
 * layers while the basket is in profit — layering is averaging *against* the position.
 */
async function resolveExistingRangeLadderAnchor(supabase, scope) {
    const { data, error } = await supabase
        .from('range_pending_legs')
        .select('anchor_price')
        .eq('signal_id', scope.signalId)
        .eq('broker_account_id', scope.brokerAccountId)
        .eq('symbol', scope.symbol)
        .gt('anchor_price', 0)
        .order('step_idx', { ascending: true })
        .limit(1);
    if (error) {
        console.warn(`[rangePendingLadderSync] anchor lookup failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${error.message}`);
        return null;
    }
    const v = Number(data?.[0]?.anchor_price);
    return Number.isFinite(v) && v > 0 ? v : null;
}
function consumedStepIndices(rows) {
    const out = new Set();
    for (const r of rows) {
        if (exports.TERMINAL_RANGE_LEG_STATUSES.includes(r.status)) {
            out.add(r.step_idx);
        }
    }
    return out;
}
function maxConsumedStepIndex(consumed) {
    let max = 0;
    for (const s of consumed) {
        if (s > max)
            max = s;
    }
    return max;
}
function pendingLegStopsForBasketRefresh(args) {
    const { row, planLeg, channelParams, plannedRangeLegs, activeRowCount, tpLots } = args;
    const legIndex = Math.max(0, row.step_idx - 1);
    const rangeLegCount = Math.max(plannedRangeLegs, activeRowCount, 1);
    const hasChannelStops = channelParams != null
        && (channelParams.stoploss != null || channelParams.tpLevels.length > 0);
    if (planLeg) {
        const stops = (0, channelActiveTradeParams_1.applyChannelParamsToVirtualLeg)({
            stoploss: planLeg.stoploss,
            takeprofit: planLeg.cweClosePrice != null ? null : planLeg.takeprofit,
        }, channelParams ?? null, { rangeLegIndex: legIndex, rangeLegCount, tpLots });
        return {
            stoploss: stops.stoploss ?? null,
            takeprofit: planLeg.cweClosePrice != null ? null : (stops.takeprofit ?? null),
            cwe_close_price: planLeg.cweClosePrice ?? null,
        };
    }
    if (!hasChannelStops)
        return null;
    const stops = (0, channelActiveTradeParams_1.applyChannelParamsToVirtualLeg)({
        stoploss: row.stoploss,
        takeprofit: row.cwe_close_price != null ? null : row.takeprofit,
    }, channelParams ?? null, { rangeLegIndex: legIndex, rangeLegCount, tpLots });
    return {
        stoploss: stops.stoploss ?? null,
        takeprofit: row.cwe_close_price != null ? null : (stops.takeprofit ?? null),
        cwe_close_price: row.cwe_close_price ?? null,
    };
}
/** Patch SL/TP on all active pending rows for one basket (SL-only refresh, no ladder replan). */
async function patchActiveRangePendingLegStops(args) {
    const { supabase, scope, stoploss, channelParams, tpLots, plannedRangeLegs = 0, } = args;
    const explicitSl = typeof stoploss === 'number' && Number.isFinite(stoploss) && stoploss > 0
        ? stoploss
        : null;
    const hasChannelStops = channelParams != null
        && (channelParams.stoploss != null || channelParams.tpLevels.length > 0);
    if (explicitSl == null && !hasChannelStops)
        return 0;
    const existing = await loadRangeLegRows(supabase, scope);
    const activeRows = existing.filter(r => r.status === 'pending' || r.status === 'claimed');
    if (!activeRows.length)
        return 0;
    let updated = 0;
    for (const row of activeRows) {
        let patch = null;
        if (hasChannelStops) {
            const computed = pendingLegStopsForBasketRefresh({
                row,
                planLeg: undefined,
                channelParams,
                plannedRangeLegs,
                activeRowCount: activeRows.length,
                tpLots,
            });
            if (computed) {
                patch = { stoploss: computed.stoploss, takeprofit: computed.takeprofit };
            }
        }
        if (explicitSl != null) {
            patch = {
                stoploss: explicitSl,
                takeprofit: patch?.takeprofit ?? (row.cwe_close_price != null ? null : row.takeprofit),
            };
        }
        if (!patch)
            continue;
        const { error } = await supabase
            .from('range_pending_legs')
            .update(patch)
            .eq('id', row.id)
            .in('status', ['pending', 'claimed']);
        if (!error)
            updated += 1;
    }
    return updated;
}
/**
 * On basket SL/TP refresh: patch SL/TP on active pendings; insert only rungs that
 * have not fired and respect total leg budget (immediates + range layering).
 */
async function syncRangePendingLadderOnBasketRefresh(args) {
    const { supabase, scope, virtualPendings, openTradeCount, plannedImmediateLegs, plannedRangeLegs, channelParams, tpLots, buildInsertRow, persistRows, context, layerTillClose = false, } = args;
    const stats = { updated: 0, inserted: 0, skippedConsumed: 0, skippedCap: 0 };
    const hasChannelStops = channelParams != null
        && (channelParams.stoploss != null || channelParams.tpLevels.length > 0);
    if (!virtualPendings.length && !hasChannelStops)
        return stats;
    const existing = await loadRangeLegRows(supabase, scope);
    const consumed = consumedStepIndices(existing);
    const maxConsumed = maxConsumedStepIndex(consumed);
    const rangeFilledEstimate = Math.max(0, openTradeCount - Math.max(0, plannedImmediateLegs));
    const minInsertStep = Math.max(maxConsumed, rangeFilledEstimate) + 1;
    const planByStep = new Map();
    for (const v of virtualPendings) {
        planByStep.set(v.stepIdx, v);
    }
    const activeRows = existing.filter(r => r.status === 'pending' || r.status === 'claimed');
    const maxTotalLegs = Math.max(0, plannedImmediateLegs + plannedRangeLegs);
    const activePendingCount = activeRows.length;
    for (const row of activeRows) {
        const planLeg = planByStep.get(row.step_idx);
        const computed = pendingLegStopsForBasketRefresh({
            row,
            planLeg,
            channelParams,
            plannedRangeLegs,
            activeRowCount: activeRows.length,
            tpLots,
        });
        if (!computed)
            continue;
        const patch = {
            stoploss: computed.stoploss,
            takeprofit: computed.takeprofit,
            cwe_close_price: computed.cwe_close_price,
        };
        const { error } = await supabase
            .from('range_pending_legs')
            .update(patch)
            .eq('id', row.id)
            .in('status', ['pending', 'claimed']);
        if (!error)
            stats.updated += 1;
    }
    if (!virtualPendings.length)
        return stats;
    if (!layerTillClose && await hasRangePendingTpTouchLock(supabase, scope)) {
        // Layering frozen (TP touch or partial close with layer-till-close off).
        stats.skippedCap += virtualPendings.length;
        return stats;
    }
    const insertRows = [];
    for (const v of virtualPendings) {
        if (consumed.has(v.stepIdx)) {
            stats.skippedConsumed += 1;
            continue;
        }
        if (v.stepIdx < minInsertStep) {
            stats.skippedConsumed += 1;
            continue;
        }
        if (activeRows.some(r => r.step_idx === v.stepIdx))
            continue;
        const projectedTotal = openTradeCount + activePendingCount + insertRows.length;
        if (maxTotalLegs > 0 && projectedTotal >= maxTotalLegs) {
            stats.skippedCap += 1;
            continue;
        }
        const legIndex = Math.max(0, v.stepIdx - 1);
        const stops = (0, channelActiveTradeParams_1.applyChannelParamsToVirtualLeg)({ stoploss: v.stoploss, takeprofit: v.takeprofit }, channelParams ?? null, { rangeLegIndex: legIndex, rangeLegCount: plannedRangeLegs, tpLots });
        const legForRow = {
            ...v,
            stoploss: stops.stoploss ?? v.stoploss,
            takeprofit: stops.takeprofit ?? v.takeprofit,
        };
        const row = buildInsertRow(legForRow);
        if (row)
            insertRows.push(row);
    }
    if (insertRows.length > 0) {
        const persist = await persistRows(insertRows, context);
        if (persist.ok)
            stats.inserted = insertRows.length;
    }
    return stats;
}
/** Mark leg fired (retain row for ladder history). */
async function markRangeLegFired(supabase, legId, ticket) {
    const { error } = await supabase
        .from('range_pending_legs')
        .update({
        status: 'fired',
        fired_at: new Date().toISOString(),
        ticket: ticket != null ? String(ticket) : null,
        claimed_at: null,
        claimed_by: null,
    })
        .eq('id', legId);
    if (error) {
        throw new Error(`markRangeLegFired failed leg=${legId}: ${error.message}`);
    }
}
/** Mark expired TTL legs (retain row). */
async function markRangeLegsExpired(supabase, legIds) {
    if (!legIds.length)
        return;
    await supabase
        .from('range_pending_legs')
        .update({
        status: 'expired',
        error_message: 'pending_expiry',
    })
        .in('id', legIds)
        .eq('status', 'pending');
}
