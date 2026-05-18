"use strict";
/**
 * Deterministic multi-trade basket merge: parameter follow-ups refresh SL/TP on the
 * latest open basket (same channel + symbol + direction) without opening new trades.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsedHasSlOrTp = parsedHasSlOrTp;
exports.isParameterFollowUpSignal = isParameterFollowUpSignal;
exports.shouldRouteAsBasketParameterRefresh = shouldRouteAsBasketParameterRefresh;
exports.mergePlanImmediateOrders = mergePlanImmediateOrders;
exports.buildPerLegStopTargets = buildPerLegStopTargets;
exports.legacyMergeLinkingEnabled = legacyMergeLinkingEnabled;
exports.resolveLatestOpenBasketAnchor = resolveLatestOpenBasketAnchor;
exports.isBareEntryFollowUp = isBareEntryFollowUp;
const manualPlanner_1 = require("./manualPlanner");
const tpBucketDistribution_1 = require("./manualPlanning/tpBucketDistribution");
const basketModFollowUp_1 = require("./basketModFollowUp");
/** True when the parsed message includes SL and/or TP price levels. */
function parsedHasSlOrTp(parsed) {
    const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0;
    const hasTp = Array.isArray(parsed.tp)
        && parsed.tp.some(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
    return hasSl || hasTp;
}
/** @alias {@link parsedHasSlOrTp} */
function isParameterFollowUpSignal(parsed) {
    return parsedHasSlOrTp(parsed);
}
/**
 * True when this signal should refresh SL/TP on an existing basket (modify-only),
 * not open a new trade. False for one-shot entry alerts (priced entry or bare NOW).
 */
function shouldRouteAsBasketParameterRefresh(parsed) {
    if (!parsedHasSlOrTp(parsed))
        return false;
    const act = String(parsed.action ?? '').toLowerCase();
    if (act === 'modify')
        return true;
    if (act === 'buy' || act === 'sell') {
        if ((0, manualPlanner_1.parsedHasExplicitEntryAnchor)(parsed)) {
            return false;
        }
        if (isBareEntryFollowUp(parsed))
            return false;
        return true;
    }
    return false;
}
/** Planner immediates used only for per-leg SL/TP during merge (never sent as new orders). */
function mergePlanImmediateOrders(plan) {
    return plan.orders.filter(o => {
        const op = String(o.operation);
        return op === 'Buy' || op === 'Sell' || op.includes('Limit') || op.includes('Stop');
    });
}
/**
 * Build one SL/TP target per open leg. Prefer planner immediates (bucket TPs); fall back
 * to parsed levels when the plan emitted zero immediates (range-only layout).
 */
function buildPerLegStopTargets(args) {
    const { plan, parsed, openLegCount, tpLots } = args;
    const n = Math.max(0, openLegCount);
    if (n === 0)
        return [];
    const fromPlan = mergePlanImmediateOrders(plan).map(o => ({
        stoploss: Number(o.stoploss) || 0,
        takeprofit: Number(o.takeprofit) || 0,
    }));
    if (fromPlan.length >= n) {
        return fromPlan.slice(0, n);
    }
    const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0;
    const parsedTps = (parsed.tp ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
    const sl = hasSl
        ? parsed.sl
        : (fromPlan[0]?.stoploss ?? 0);
    let finalTps = parsedTps;
    if (!finalTps.length && fromPlan.length > 0) {
        finalTps = fromPlan
            .map(o => o.takeprofit)
            .filter(tp => typeof tp === 'number' && Number.isFinite(tp) && tp > 0);
    }
    const tpPrices = (0, tpBucketDistribution_1.buildDistributedPerLegTakeProfits)({
        openLegCount: n,
        finalTps,
        tpLots,
    });
    return tpPrices.map(tp => ({
        stoploss: sl,
        takeprofit: tp,
    }));
}
/** When false, entry follow-ups still use legacy reply/thread merge linking. */
function legacyMergeLinkingEnabled() {
    const v = String(process.env.WORKER_LEGACY_MERGE_LINKING ?? 'false').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}
/**
 * Latest open basket for broker + symbol + direction, optionally scoped to channel.
 * When multiple signal_ids have open legs, picks the one with the newest `opened_at`.
 */
async function resolveLatestOpenBasketAnchor(supabase, args) {
    const { data: openTrades, error } = await supabase
        .from('trades')
        .select('signal_id, opened_at, symbol')
        .eq('user_id', args.userId)
        .eq('broker_account_id', args.brokerAccountId)
        .eq('status', 'open')
        .eq('direction', args.direction)
        .order('opened_at', { ascending: false })
        .limit(200);
    if (error || !openTrades?.length)
        return null;
    const symHint = args.signalSymbol ?? args.brokerSymbol;
    const matching = openTrades
        .filter(row => (0, basketModFollowUp_1.symbolsCompatibleForBasket)(symHint, row.symbol)
        || (0, basketModFollowUp_1.symbolsCompatibleForBasket)(args.brokerSymbol, row.symbol));
    if (!matching.length)
        return null;
    const newestBySignal = new Map();
    for (const row of matching) {
        const sid = row.signal_id;
        if (!sid)
            continue;
        const prev = newestBySignal.get(sid);
        if (!prev || new Date(row.opened_at).getTime() > new Date(prev).getTime()) {
            newestBySignal.set(sid, row.opened_at);
        }
    }
    const signalIds = [...newestBySignal.keys()];
    if (!signalIds.length)
        return null;
    const { data: sigRows } = await supabase
        .from('signals')
        .select('id, channel_id')
        .in('id', signalIds);
    let candidates = (sigRows ?? []);
    if (args.channelId) {
        candidates = candidates.filter(s => s.channel_id === args.channelId);
    }
    if (!candidates.length)
        return null;
    let best = null;
    for (const s of candidates) {
        const openedAt = newestBySignal.get(s.id);
        if (!openedAt)
            continue;
        if (!best
            || new Date(openedAt).getTime() > new Date(best.newestOpenedAt).getTime()) {
            best = {
                anchorSignalId: s.id,
                channelId: s.channel_id,
                newestOpenedAt: openedAt,
            };
        }
    }
    return best;
}
/** Entry-shaped follow-up without SL/TP is not a parameter refresh. */
function isBareEntryFollowUp(parsed) {
    return (!parsedHasSlOrTp(parsed)
        && !(0, manualPlanner_1.parsedHasExplicitEntryAnchor)(parsed));
}
