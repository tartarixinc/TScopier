"use strict";
/**
 * Deterministic multi-trade basket merge: parameter follow-ups refresh SL/TP on the
 * latest open basket (same channel + symbol + direction) without opening new trades.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsedHasSlOrTp = parsedHasSlOrTp;
exports.shouldRouteAsBasketParameterRefresh = shouldRouteAsBasketParameterRefresh;
exports.mergePlanImmediateOrders = mergePlanImmediateOrders;
exports.buildPerLegStopTargets = buildPerLegStopTargets;
exports.legacyMergeLinkingEnabled = legacyMergeLinkingEnabled;
exports.filterSignalIdsByChannel = filterSignalIdsByChannel;
exports.resolveLatestOpenBasketAnchor = resolveLatestOpenBasketAnchor;
exports.resolveOpenBasketAnchorForSameSignal = resolveOpenBasketAnchorForSameSignal;
exports.resolveOpenBasketAnchorForParameterFollowUp = resolveOpenBasketAnchorForParameterFollowUp;
const manualPlanner_1 = require("./manualPlanner");
const signalPriceInference_1 = require("./signalPriceInference");
const signalEntryNowRequirement_1 = require("./signalEntryNowRequirement");
const tpBucketDistribution_1 = require("./manualPlanning/tpBucketDistribution");
const signalMergeLink_1 = require("./signalMergeLink");
const basketModFollowUp_1 = require("./basketModFollowUp");
/** True when the parsed message includes SL and/or TP price levels. */
function parsedHasSlOrTp(parsed) {
    const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0;
    const hasTp = Array.isArray(parsed.tp)
        && parsed.tp.some(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
    return hasSl || hasTp;
}
/**
 * True when this signal should refresh SL/TP on an existing basket (modify-only),
 * not open a new trade. False for one-shot entry alerts (priced entry or bare NOW).
 */
function shouldRouteAsBasketParameterRefresh(parsed) {
    if (!parsedHasSlOrTp(parsed))
        return false;
    if ((0, signalPriceInference_1.parsedHasReEnterIntent)(parsed))
        return false;
    const act = String(parsed.action ?? '').toLowerCase();
    if (act === 'modify')
        return true;
    if (act === 'buy' || act === 'sell') {
        if (isBareEntryFollowUp(parsed))
            return false;
        // Full entry alerts (priced entry or zone) must open a trade — not SL/TP-only refresh.
        if ((0, manualPlanner_1.parsedHasExplicitEntryAnchor)(parsed)) {
            return false;
        }
        // "BUY NOW + SL/TP" (no priced entry) is an explicit market entry, not a
        // follow-up refresh — must open a trade and stay on the entry fast path.
        if ((0, signalEntryNowRequirement_1.messageHasMarketNowIntent)(parsed.raw_instruction ?? ''))
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
 * Build one SL/TP target per open leg using Targets % (50/30/20, etc.).
 * Always emits `openLegCount` entries — range baskets often have more filled legs than
 * immediate `plan.orders`, so we never clone the last immediate order's TP onto extras.
 */
function buildPerLegStopTargets(args) {
    const { plan, parsed, openLegCount, totalPlannedLegCount, immediateLegCount, tpLots } = args;
    const n = Math.max(0, openLegCount);
    if (n === 0)
        return [];
    const fromPlan = mergePlanImmediateOrders(plan).map(o => ({
        stoploss: Number(o.stoploss) || 0,
        takeprofit: Number(o.takeprofit) || 0,
    }));
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
    const immCount = Math.max(0, immediateLegCount ?? fromPlan.length);
    const total = Math.max(n, totalPlannedLegCount ?? n);
    const rangeCount = Math.max(0, total - immCount);
    return Array.from({ length: n }, (_, i) => ({
        stoploss: sl,
        takeprofit: (0, tpBucketDistribution_1.takeProfitForSplitBasketLeg)({
            legIndex: i,
            immediateLegCount: immCount,
            rangeLegCount: rangeCount,
            finalTps,
            tpLots,
        }),
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
/** Keep basket merge / anchor selection scoped to one Telegram channel. */
async function filterSignalIdsByChannel(supabase, userId, channelId, signalIds) {
    const unique = [...new Set(signalIds.filter(Boolean))];
    if (!unique.length)
        return new Set();
    const { data, error } = await supabase
        .from('signals')
        .select('id')
        .eq('user_id', userId)
        .eq('channel_id', channelId)
        .in('id', unique);
    if (error) {
        console.warn(`[multiTradeMerge] channel signal filter failed: ${error.message}`);
        return new Set();
    }
    return new Set((data ?? []).map((r) => r.id));
}
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
const PARAMETER_FOLLOW_UP_ANCHOR_RETRY_MS = 3000;
const PARAMETER_FOLLOW_UP_ANCHOR_POLL_MS = 150;
/**
 * Same-signal revision re-parses the existing `signals` row — anchor SL/TP refresh
 * on that signal's open legs, not the newest unrelated basket on the channel.
 */
async function resolveOpenBasketAnchorForSameSignal(supabase, args) {
    const { data: rows, error } = await supabase
        .from('trades')
        .select('opened_at,symbol')
        .eq('user_id', args.userId)
        .eq('broker_account_id', args.brokerAccountId)
        .eq('signal_id', args.signalId)
        .eq('status', 'open')
        .eq('direction', args.direction)
        .order('opened_at', { ascending: false })
        .limit(500);
    if (error) {
        console.warn(`[multiTradeMerge] same-signal anchor load failed signal=${args.signalId}: ${error.message}`);
        return null;
    }
    const symHint = args.signalSymbol ?? args.brokerSymbol;
    let newestOpenedAt = null;
    for (const row of rows ?? []) {
        const trSym = String(row.symbol ?? '');
        if (trSym
            && !(0, basketModFollowUp_1.symbolsCompatibleForBasket)(symHint, trSym)
            && !(0, basketModFollowUp_1.symbolsCompatibleForBasket)(args.brokerSymbol, trSym)) {
            continue;
        }
        const openedAt = String(row.opened_at ?? '');
        if (!openedAt)
            continue;
        if (!newestOpenedAt || new Date(openedAt).getTime() > new Date(newestOpenedAt).getTime()) {
            newestOpenedAt = openedAt;
        }
    }
    if (!newestOpenedAt)
        return null;
    return {
        anchorSignalId: args.signalId,
        channelId: args.channelId ?? null,
        newestOpenedAt,
    };
}
/** Wait briefly for the entry leg to land in DB before opening a duplicate trade. */
async function resolveOpenBasketAnchorForParameterFollowUp(supabase, args, opts) {
    const retryMs = opts?.retryMs ?? PARAMETER_FOLLOW_UP_ANCHOR_RETRY_MS;
    const deadline = Date.now() + retryMs;
    while (Date.now() < deadline) {
        const anchor = await resolveLatestOpenBasketAnchor(supabase, args);
        if (anchor)
            return anchor;
        await new Promise(resolve => setTimeout(resolve, PARAMETER_FOLLOW_UP_ANCHOR_POLL_MS));
    }
    return resolveRecentEntrySignalAnchor(supabase, args, opts);
}
async function resolveRecentEntrySignalAnchor(supabase, args, opts) {
    if (!args.channelId)
        return null;
    const followUpMs = opts?.currentSignalCreatedAt
        ? new Date(opts.currentSignalCreatedAt).getTime()
        : Date.now();
    if (!Number.isFinite(followUpMs))
        return null;
    const { data: rows, error } = await supabase
        .from('signals')
        .select('id, channel_id, created_at, parsed_data, status')
        .eq('user_id', args.userId)
        .eq('channel_id', args.channelId)
        .order('created_at', { ascending: false })
        .limit(10);
    if (error || !rows?.length)
        return null;
    for (const row of rows) {
        if (row.id === opts?.currentSignalId)
            continue;
        const parsed = row.parsed_data ?? {};
        const act = String(parsed.action ?? '').toLowerCase();
        if (act !== args.direction)
            continue;
        if (shouldRouteAsBasketParameterRefresh(parsed))
            continue;
        const createdMs = new Date(row.created_at).getTime();
        const dtMs = followUpMs - createdMs;
        if (!Number.isFinite(createdMs) || dtMs < 0 || dtMs > signalMergeLink_1.MERGE_IMPLICIT_CHANNEL_BUNDLE_MS)
            continue;
        const sym = parsed.symbol ?? null;
        if (sym
            && args.signalSymbol
            && !(0, basketModFollowUp_1.symbolsCompatibleForBasket)(sym, args.signalSymbol)
            && !(0, basketModFollowUp_1.symbolsCompatibleForBasket)(sym, args.brokerSymbol)) {
            continue;
        }
        return {
            anchorSignalId: row.id,
            channelId: row.channel_id,
            newestOpenedAt: row.created_at,
        };
    }
    return null;
}
/** Entry-shaped follow-up without SL/TP is not a parameter refresh. */
function isBareEntryFollowUp(parsed) {
    return (!parsedHasSlOrTp(parsed)
        && !(0, manualPlanner_1.parsedHasExplicitEntryAnchor)(parsed));
}
