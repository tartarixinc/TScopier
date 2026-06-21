"use strict";
/**
 * Single source of truth for open-basket SL/TP authority (anchor vs adjust vs channel memory).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findLatestMgmtModifySl = void 0;
exports.unanimousLegSl = unanimousLegSl;
exports.mostProtectiveOpenLegSl = mostProtectiveOpenLegSl;
exports.mergeWithProtectiveLegSl = mergeWithProtectiveLegSl;
exports.isSlMoreProtective = isSlMoreProtective;
exports.resolveEffectiveStoplossPriority = resolveEffectiveStoplossPriority;
exports.findLatestMgmtSlAdjustment = findLatestMgmtSlAdjustment;
exports.resolveEffectiveBasketStops = resolveEffectiveBasketStops;
exports.logEffectiveBasketStops = logEffectiveBasketStops;
const channelActiveTradeParams_1 = require("./channelActiveTradeParams");
const basketModFollowUp_1 = require("./basketModFollowUp");
const rangeBasketTpSync_1 = require("./rangeBasketTpSync");
const MGMT_SL_ACTIONS = new Set(['modify', 'breakeven', 'partial_breakeven']);
function sanitizeLevel(v) {
    const n = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
function inferIsBuy(familyTrades) {
    const dir = String(familyTrades?.[0]?.direction ?? 'buy').toLowerCase();
    return dir !== 'sell';
}
function unanimousLegSl(familyTrades) {
    if (!familyTrades?.length)
        return null;
    const levels = new Set();
    for (const tr of familyTrades) {
        const sl = sanitizeLevel(tr.sl);
        if (sl <= 0)
            return null;
        levels.add(sl);
    }
    if (levels.size !== 1)
        return null;
    return [...levels][0];
}
/** Highest SL for buys / lowest for sells among open legs (breakeven-tightened legs). */
function mostProtectiveOpenLegSl(familyTrades, isBuy) {
    if (!familyTrades?.length)
        return null;
    let best = null;
    for (const tr of familyTrades) {
        const sl = sanitizeLevel(tr.sl);
        if (sl <= 0)
            continue;
        if (best == null)
            best = sl;
        else if (isBuy)
            best = Math.max(best, sl);
        else
            best = Math.min(best, sl);
    }
    return best;
}
function mergeWithProtectiveLegSl(resolvedSl, protectiveSl, isBuy) {
    if (protectiveSl == null || protectiveSl <= 0)
        return resolvedSl;
    if (resolvedSl <= 0)
        return protectiveSl;
    return isBuy ? Math.max(resolvedSl, protectiveSl) : Math.min(resolvedSl, protectiveSl);
}
/** True when `currentSl` is tighter than `targetSl` for the trade direction. */
function isSlMoreProtective(currentSl, targetSl, isBuy, epsilon = 1e-8) {
    if (currentSl <= 0 || targetSl <= 0)
        return false;
    if (isBuy)
        return currentSl > targetSl + epsilon;
    return currentSl < targetSl - epsilon;
}
/** Pure SL priority for unit tests. */
function resolveEffectiveStoplossPriority(args) {
    const mgmt = args.mgmtSl != null && args.mgmtSl > 0 ? args.mgmtSl : null;
    if (mgmt != null)
        return { stoploss: mgmt, source: 'mgmt_signal' };
    const channel = args.channelSl != null && args.channelSl > 0 ? args.channelSl : null;
    if (channel != null)
        return { stoploss: channel, source: 'channel_memory' };
    const anchor = args.anchorSl > 0 ? args.anchorSl : 0;
    const consensus = args.legConsensus != null && args.legConsensus > 0 ? args.legConsensus : null;
    if (consensus != null && (anchor <= 0 || consensus !== anchor)) {
        return { stoploss: consensus, source: 'leg_consensus' };
    }
    return { stoploss: anchor, source: anchor > 0 ? 'anchor' : 'anchor' };
}
async function findLatestMgmtSlAdjustment(supabase, args) {
    const { data: candidates, error } = await supabase
        .from('signals')
        .select('id, parsed_data, created_at')
        .eq('user_id', args.userId)
        .eq('channel_id', args.channelId)
        .in('status', ['parsed', 'executed'])
        .gte('created_at', args.basketCreatedAt)
        .order('created_at', { ascending: false })
        .limit(60);
    if (error) {
        console.warn(`[effectiveStops] mgmt signal scan failed: ${error.message}`);
        return null;
    }
    for (const row of candidates ?? []) {
        const parsed = row.parsed_data;
        if (!parsed?.action)
            continue;
        const action = String(parsed.action).toLowerCase();
        if (!MGMT_SL_ACTIONS.has(action))
            continue;
        if (!(0, basketModFollowUp_1.mgmtSignalMatchesBasketSymbol)(parsed, args.symbol))
            continue;
        const sl = sanitizeLevel(parsed.sl);
        if (sl <= 0)
            continue;
        return {
            sl,
            signalId: String(row.id),
            tpLevels: (0, rangeBasketTpSync_1.coercePositiveTpLevels)(parsed.tp),
        };
    }
    return null;
}
/** @deprecated Use findLatestMgmtSlAdjustment */
exports.findLatestMgmtModifySl = findLatestMgmtSlAdjustment;
async function resolveEffectiveBasketStops(args) {
    const anchorSl = sanitizeLevel(args.anchorParsed.sl);
    let tpLevels = (0, rangeBasketTpSync_1.coercePositiveTpLevels)(args.anchorParsed.tp);
    const isBuy = inferIsBuy(args.familyTrades);
    let mgmtSl = null;
    let sourceSignalId;
    if (args.channelId && args.basketCreatedAt) {
        const mgmt = await findLatestMgmtSlAdjustment(args.supabase, {
            userId: args.userId,
            channelId: args.channelId,
            basketCreatedAt: args.basketCreatedAt,
            symbol: args.symbol,
        });
        if (mgmt) {
            mgmtSl = mgmt.sl;
            sourceSignalId = mgmt.signalId;
            if (mgmt.tpLevels.length)
                tpLevels = mgmt.tpLevels;
        }
    }
    let channelSl = null;
    let channelParams = null;
    if (args.channelId) {
        channelParams = await (0, channelActiveTradeParams_1.loadChannelActiveTradeParamsForSymbol)(args.supabase, args.userId, args.channelId, args.symbol);
        if (channelParams && args.basketCreatedAt && (0, channelActiveTradeParams_1.channelParamsPredateBasket)(channelParams, args.basketCreatedAt)) {
            channelParams = null;
        }
        else if (channelParams) {
            channelSl = channelParams.stoploss != null ? sanitizeLevel(channelParams.stoploss) : null;
            if (channelParams.tpLevels.length > 0 && !mgmtSl) {
                tpLevels = [...channelParams.tpLevels];
            }
        }
    }
    const legConsensus = unanimousLegSl(args.familyTrades);
    const { stoploss: prioritySl, source } = resolveEffectiveStoplossPriority({
        anchorSl,
        mgmtSl,
        channelSl: channelSl && channelSl > 0 ? channelSl : null,
        legConsensus,
    });
    const protectiveLegSl = mostProtectiveOpenLegSl(args.familyTrades, isBuy);
    const stoploss = mergeWithProtectiveLegSl(prioritySl, protectiveLegSl, isBuy);
    const parsedSlice = {
        sl: stoploss > 0 ? stoploss : args.anchorParsed.sl,
        tp: tpLevels.length ? tpLevels : args.anchorParsed.tp,
    };
    return {
        stoploss,
        tpLevels,
        parsedSlice,
        source,
        sourceSignalId,
        anchorSl,
    };
}
function logEffectiveBasketStops(prefix, anchorSignalId, effective) {
    const tag = prefix.endsWith(' ') ? prefix.slice(0, -1) : prefix;
    console.log(`${tag} [effectiveStops] basket=${anchorSignalId} sl=${effective.stoploss}`
        + ` source=${effective.source}${effective.sourceSignalId ? ` signal=${effective.sourceSignalId}` : ''}`
        + ` anchor_sl=${effective.anchorSl}`);
}
