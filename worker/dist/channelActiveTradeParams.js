"use strict";
/**
 * Persist and apply channel-level SL/TP from management / parameter refresh.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.symbolsForChannelParamsPersist = symbolsForChannelParamsPersist;
exports.loadChannelActiveTradeParamsForSymbol = loadChannelActiveTradeParamsForSymbol;
exports.upsertChannelActiveTradeParams = upsertChannelActiveTradeParams;
exports.parsedSignalHasExplicitStops = parsedSignalHasExplicitStops;
exports.isFullEntrySignalWithStops = isFullEntrySignalWithStops;
exports.shouldPreferSignalStopsOverChannelMemory = shouldPreferSignalStopsOverChannelMemory;
exports.shouldOverlayChannelParamsOnBasketRefresh = shouldOverlayChannelParamsOnBasketRefresh;
exports.refreshChannelParamsFromSignal = refreshChannelParamsFromSignal;
exports.shouldMergeChannelParamsForEntry = shouldMergeChannelParamsForEntry;
exports.channelHasOpenActivityForSymbol = channelHasOpenActivityForSymbol;
exports.shouldSeedChannelParamsFromEntrySignal = shouldSeedChannelParamsFromEntrySignal;
exports.resolveEntryChannelStops = resolveEntryChannelStops;
exports.mergeParsedWithChannelParams = mergeParsedWithChannelParams;
exports.stripInvalidStopsForSide = stripInvalidStopsForSide;
exports.estimateBasketTotalPlannedLegs = estimateBasketTotalPlannedLegs;
exports.globalLegIndexForRangePending = globalLegIndexForRangePending;
exports.resolvePendingLegTp = resolvePendingLegTp;
exports.applyChannelParamsToVirtualPendingList = applyChannelParamsToVirtualPendingList;
exports.applyChannelParamsToVirtualLeg = applyChannelParamsToVirtualLeg;
exports.reapplyChannelParamsToPendingLegs = reapplyChannelParamsToPendingLegs;
const basketModFollowUp_1 = require("./basketModFollowUp");
const tpBucketDistribution_1 = require("./manualPlanning/tpBucketDistribution");
const parsedEntry_1 = require("./manualPlanning/parsedEntry");
function positiveLevel(v) {
    const n = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
}
function normalizeTpLevels(tp) {
    if (!Array.isArray(tp))
        return [];
    return tp.filter((t) => positiveLevel(t) != null);
}
function symbolsForChannelParamsPersist(args) {
    const out = new Set();
    const hint = args.symbolFromText?.trim();
    if (hint)
        out.add(hint);
    for (const s of [...args.tradeSymbols, ...args.pendingSymbols]) {
        const t = s?.trim();
        if (t)
            out.add(t);
    }
    return [...out];
}
async function loadChannelActiveTradeParamsForSymbol(supabase, userId, channelId, symbolHint) {
    const { data, error } = await supabase
        .from('channel_active_trade_params')
        .select('symbol,stoploss,tp_levels')
        .eq('user_id', userId)
        .eq('channel_id', channelId)
        .limit(200);
    if (error) {
        console.warn(`[channelActiveTradeParams] load failed: ${error.message}`);
        return null;
    }
    const rows = (data ?? []);
    const match = rows.find(r => (0, basketModFollowUp_1.symbolsCompatibleForBasket)(symbolHint, r.symbol));
    if (!match)
        return null;
    return {
        symbol: match.symbol,
        stoploss: positiveLevel(match.stoploss),
        tpLevels: normalizeTpLevels(match.tp_levels),
    };
}
async function upsertChannelActiveTradeParams(supabase, args) {
    const { userId, channelId, symbols, stoploss, tpLevels, replace = false } = args;
    const sl = stoploss != null ? positiveLevel(stoploss) : null;
    const tps = tpLevels != null ? normalizeTpLevels(tpLevels) : null;
    if (sl == null && (tps == null || tps.length === 0))
        return;
    if (!symbols.length)
        return;
    const now = new Date().toISOString();
    for (const sym of symbols) {
        const key = sym.trim();
        if (!key)
            continue;
        const existing = await loadChannelActiveTradeParamsForSymbol(supabase, userId, channelId, key);
        const hasExplicitSl = sl != null;
        const hasExplicitTps = tps != null && tps.length > 0;
        const row = {
            user_id: userId,
            channel_id: channelId,
            symbol: existing?.symbol ?? key.toUpperCase(),
            stoploss: replace && hasExplicitSl
                ? sl
                : (sl ?? existing?.stoploss ?? null),
            tp_levels: replace && hasExplicitTps
                ? tps
                : (tps != null && tps.length > 0 ? tps : (existing?.tpLevels ?? [])),
            updated_at: now,
        };
        const { error } = await supabase
            .from('channel_active_trade_params')
            .upsert(row, { onConflict: 'user_id,channel_id,symbol' });
        if (error) {
            console.warn(`[channelActiveTradeParams] upsert ${key} failed: ${error.message}`);
        }
    }
}
/** True when the Telegram message itself included SL and/or TP (not channel memory). */
function parsedSignalHasExplicitStops(parsed) {
    const hasSl = positiveLevel(parsed.sl) != null;
    const hasTp = (parsed.tp ?? []).some(t => positiveLevel(t) != null);
    return hasSl || hasTp;
}
/**
 * True for a buy/sell that carries its own entry anchor and SL/TP — a full new entry,
 * not an SL/TP-only parameter follow-up. Stale channel memory must not overlay these.
 */
function isFullEntrySignalWithStops(parsed) {
    const act = String(parsed.action ?? '').toLowerCase();
    if (act !== 'buy' && act !== 'sell')
        return false;
    if (!(0, parsedEntry_1.parsedHasExplicitEntryAnchor)(parsed))
        return false;
    return parsedSignalHasExplicitStops(parsed);
}
/**
 * Full entries with explicit SL/TP must win over stale `channel_active_trade_params`.
 * Use this before overlaying or gap-filling from channel memory on entry paths.
 */
function shouldPreferSignalStopsOverChannelMemory(parsed) {
    return isFullEntrySignalWithStops(parsed);
}
/**
 * True when basket merge / refresh may overlay channel memory onto parsed stops.
 */
function shouldOverlayChannelParamsOnBasketRefresh(parsed, logAction) {
    if (logAction !== 'signal_merge_into_open_trade')
        return false;
    return !shouldPreferSignalStopsOverChannelMemory(parsed);
}
/** Upsert channel memory from signal stops (no overlay). For live-entry fast path. */
async function refreshChannelParamsFromSignal(supabase, args) {
    if (!parsedSignalHasExplicitStops(args.plannerParsed))
        return null;
    const refreshTpLevels = (args.plannerParsed.tp ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
    await upsertChannelActiveTradeParams(supabase, {
        userId: args.userId,
        channelId: args.channelId,
        symbols: [args.symbol],
        stoploss: args.plannerParsed.sl,
        tpLevels: refreshTpLevels,
        replace: args.replace ?? shouldPreferSignalStopsOverChannelMemory(args.plannerParsed),
    });
    return loadChannelActiveTradeParamsForSymbol(supabase, args.userId, args.channelId, args.symbol);
}
/**
 * Channel memory from Adjust SL applies to management + pending ladder refresh,
 * not naked "buy/sell" posts — otherwise stale levels cause "Invalid stops".
 */
function shouldMergeChannelParamsForEntry(parsed) {
    return parsedSignalHasExplicitStops(parsed);
}
/** Open trades or active range pendings on this channel+broker for the symbol family. */
async function channelHasOpenActivityForSymbol(supabase, args) {
    const { data: sigs, error: sigErr } = await supabase
        .from('signals')
        .select('id')
        .eq('user_id', args.userId)
        .eq('channel_id', args.channelId)
        .limit(2000);
    if (sigErr || !sigs?.length)
        return false;
    const signalIds = sigs.map((r) => r.id);
    const { data: trades } = await supabase
        .from('trades')
        .select('symbol')
        .eq('user_id', args.userId)
        .eq('broker_account_id', args.brokerAccountId)
        .eq('status', 'open')
        .in('signal_id', signalIds)
        .limit(200);
    if ((trades ?? []).some((t) => (0, basketModFollowUp_1.symbolsCompatibleForBasket)(args.symbolHint, t.symbol))) {
        return true;
    }
    const { data: pending } = await supabase
        .from('range_pending_legs')
        .select('symbol')
        .eq('user_id', args.userId)
        .eq('broker_account_id', args.brokerAccountId)
        .in('signal_id', signalIds)
        .in('status', ['pending', 'claimed'])
        .limit(200);
    return (pending ?? []).some((l) => (0, basketModFollowUp_1.symbolsCompatibleForBasket)(args.symbolHint, l.symbol));
}
/**
 * When a basket is already live, stale SL/TP copied from the provider template must not
 * overwrite Adjust SL memory or seed new range legs.
 */
function shouldSeedChannelParamsFromEntrySignal(hasActiveBasket) {
    return !hasActiveBasket;
}
/** Resolve planner SL/TP for a new entry: prefer channel memory when basket is active. */
async function resolveEntryChannelStops(supabase, args) {
    const channelParams = await loadChannelActiveTradeParamsForSymbol(supabase, args.userId, args.channelId, args.symbol);
    const hasActiveBasket = await channelHasOpenActivityForSymbol(supabase, {
        userId: args.userId,
        channelId: args.channelId,
        brokerAccountId: args.brokerAccountId,
        symbolHint: args.symbol,
    });
    let plannerParsed = args.plannerParsed;
    let mergedChannelParams = false;
    const preferSignalStops = shouldPreferSignalStopsOverChannelMemory(plannerParsed);
    const applyOverlay = hasActiveBasket && channelParams != null && !preferSignalStops;
    if (applyOverlay) {
        console.log(`[channelActiveTradeParams] overlay applied signal=${args.signalId ?? 'n/a'}`
            + ` broker=${args.brokerAccountId} channel=${args.channelId}`
            + ` signal_sl=${plannerParsed.sl ?? 'n/a'} channel_sl=${channelParams.stoploss ?? 'n/a'}`);
        plannerParsed = mergeParsedWithChannelParams(plannerParsed, channelParams, { overlay: true });
        mergedChannelParams = true;
    }
    else if (hasActiveBasket && channelParams && preferSignalStops) {
        console.log(`[channelActiveTradeParams] overlay skipped full entry signal=${args.signalId ?? 'n/a'}`
            + ` broker=${args.brokerAccountId} channel=${args.channelId}`
            + ` signal_sl=${plannerParsed.sl ?? 'n/a'} channel_sl=${channelParams.stoploss ?? 'n/a'}`);
    }
    if (parsedSignalHasExplicitStops(plannerParsed)) {
        const refreshTpLevels = (plannerParsed.tp ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
        await upsertChannelActiveTradeParams(supabase, {
            userId: args.userId,
            channelId: args.channelId,
            symbols: [args.symbol],
            stoploss: plannerParsed.sl,
            tpLevels: refreshTpLevels,
            replace: preferSignalStops,
        });
    }
    else if (channelParams && !applyOverlay) {
        plannerParsed = mergeParsedWithChannelParams(plannerParsed, channelParams);
        mergedChannelParams = true;
    }
    const refreshedParams = await loadChannelActiveTradeParamsForSymbol(supabase, args.userId, args.channelId, args.symbol);
    return {
        plannerParsed,
        mergedChannelParams,
        channelParams: refreshedParams,
    };
}
/** Overlay channel SL/TP onto parsed signal before planning orders / virtual pendings. */
function mergeParsedWithChannelParams(parsed, params, opts) {
    if (!params)
        return parsed;
    const next = {
        ...parsed,
        tp: parsed.tp ? [...parsed.tp] : parsed.tp,
    };
    const hasSl = positiveLevel(parsed.sl) != null;
    const hasTp = (parsed.tp ?? []).some(t => positiveLevel(t) != null);
    if (opts?.overlay) {
        if (params.stoploss != null)
            next.sl = params.stoploss;
        if (params.tpLevels.length > 0)
            next.tp = [...params.tpLevels];
        return next;
    }
    if (!hasSl && params.stoploss != null)
        next.sl = params.stoploss;
    if (!hasTp && params.tpLevels.length > 0)
        next.tp = [...params.tpLevels];
    return next;
}
/** Drop SL/TP on the wrong side of the fill reference (broker rejects as invalid stops). */
function stripInvalidStopsForSide(args) {
    const { referencePrice, isBuy } = args;
    const ref = referencePrice;
    if (!Number.isFinite(ref) || ref <= 0) {
        return { stoploss: args.stoploss, takeprofit: args.takeprofit, stripped: [] };
    }
    let stoploss = args.stoploss;
    let takeprofit = args.takeprofit;
    const stripped = [];
    if (stoploss > 0) {
        const bad = isBuy ? stoploss >= ref : stoploss <= ref;
        if (bad) {
            stripped.push(`sl ${stoploss}`);
            stoploss = 0;
        }
    }
    if (takeprofit > 0) {
        const bad = isBuy ? takeprofit <= ref : takeprofit >= ref;
        if (bad) {
            stripped.push(`tp ${takeprofit}`);
            takeprofit = 0;
        }
    }
    return { stoploss, takeprofit, stripped };
}
function estimateBasketTotalPlannedLegs(args) {
    const { openLegCount, activePendingCount, maxPendingStepIdx } = args;
    if (maxPendingStepIdx <= 0)
        return Math.max(0, openLegCount);
    const firedPendingApprox = Math.max(0, maxPendingStepIdx - activePendingCount);
    const immediateLegCount = Math.max(0, openLegCount - firedPendingApprox);
    return immediateLegCount + maxPendingStepIdx;
}
function globalLegIndexForRangePending(args) {
    return Math.max(0, args.immediateLegCount + args.stepIdx - 1);
}
function resolvePendingLegTp(args) {
    const { stepIdx, rangeLegCount, channelTpLevels, tpLots, fallbackTp } = args;
    if (!channelTpLevels.length)
        return positiveLevel(fallbackTp);
    const rangeLegIndex = Math.max(0, stepIdx - 1);
    const distributed = (0, tpBucketDistribution_1.takeProfitForPoolLegIndex)({
        poolLegIndex: rangeLegIndex,
        poolLegCount: Math.max(rangeLegCount, rangeLegIndex + 1),
        finalTps: channelTpLevels,
        tpLots,
    });
    if (distributed > 0)
        return distributed;
    return channelTpLevels[channelTpLevels.length - 1] ?? positiveLevel(fallbackTp);
}
function applyChannelParamsToVirtualPendingList(legs, params, _immediateLegCount, tpLots, _totalPlannedLegCount) {
    if (!params)
        return legs;
    const rangeLegCount = legs.length;
    return legs.map(v => {
        const stops = applyChannelParamsToVirtualLeg(v, params, {
            rangeLegIndex: Math.max(0, v.stepIdx - 1),
            rangeLegCount,
            tpLots,
        });
        return {
            ...v,
            stoploss: stops.stoploss ?? v.stoploss,
            takeprofit: stops.takeprofit ?? v.takeprofit,
        };
    });
}
function applyChannelParamsToVirtualLeg(leg, params, args) {
    if (!params)
        return leg;
    let stoploss = leg.stoploss;
    let takeprofit = leg.takeprofit;
    if (params.stoploss != null)
        stoploss = params.stoploss;
    if (params.tpLevels.length > 0) {
        takeprofit = resolvePendingLegTp({
            stepIdx: args.rangeLegIndex + 1,
            rangeLegCount: args.rangeLegCount,
            channelTpLevels: params.tpLevels,
            tpLots: args.tpLots,
            fallbackTp: leg.takeprofit,
        });
    }
    return { stoploss, takeprofit };
}
async function reapplyChannelParamsToPendingLegs(args) {
    const params = await loadChannelActiveTradeParamsForSymbol(args.supabase, args.userId, args.channelId, args.symbolHint);
    if (!params || (params.stoploss == null && params.tpLevels.length === 0))
        return 0;
    let signalIds = args.signalIds ?? null;
    if (!signalIds?.length) {
        const { data: sigs } = await args.supabase
            .from('signals')
            .select('id')
            .eq('user_id', args.userId)
            .eq('channel_id', args.channelId)
            .limit(5000);
        signalIds = (sigs ?? []).map((r) => r.id);
        if (!signalIds.length)
            return 0;
    }
    let query = args.supabase
        .from('range_pending_legs')
        .select('id,signal_id,broker_account_id,symbol,step_idx,stoploss,takeprofit,cwe_close_price,status')
        .eq('user_id', args.userId)
        .in('broker_account_id', args.brokerAccountIds)
        .in('signal_id', signalIds)
        .in('status', ['pending', 'claimed'])
        .limit(500);
    const { data, error } = await query;
    if (error) {
        console.warn(`[channelActiveTradeParams] pending load failed: ${error.message}`);
        return 0;
    }
    let updated = 0;
    const pendingByBasket = new Map();
    for (const leg of data ?? []) {
        const basketKey = `${leg.signal_id}|${leg.broker_account_id}`;
        const list = pendingByBasket.get(basketKey) ?? [];
        list.push(leg);
        pendingByBasket.set(basketKey, list);
    }
    for (const leg of data ?? []) {
        if (!(0, basketModFollowUp_1.symbolsCompatibleForBasket)(args.symbolHint, leg.symbol))
            continue;
        const basketKey = `${leg.signal_id}|${leg.broker_account_id}`;
        const basketPending = pendingByBasket.get(basketKey) ?? [leg];
        const maxStepIdx = Math.max(...basketPending.map(row => row.step_idx), 0);
        const tpLots = args.tpLotsByBroker.get(leg.broker_account_id);
        const applied = applyChannelParamsToVirtualLeg({ stoploss: leg.stoploss, takeprofit: leg.takeprofit }, params, {
            rangeLegIndex: Math.max(0, leg.step_idx - 1),
            rangeLegCount: maxStepIdx,
            tpLots,
        });
        const patch = {
            stoploss: applied.stoploss,
            takeprofit: leg.cwe_close_price != null ? null : applied.takeprofit,
        };
        const { error: upErr } = await args.supabase
            .from('range_pending_legs')
            .update(patch)
            .eq('id', leg.id)
            .in('status', ['pending', 'claimed']);
        if (!upErr)
            updated++;
    }
    return updated;
}
