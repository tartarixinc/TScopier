"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.symbolsCompatibleForBasket = symbolsCompatibleForBasket;
exports.tryApplyBasketFollowUpToNewFill = tryApplyBasketFollowUpToNewFill;
const normalizeManualSettings_1 = require("./manualPlanning/normalizeManualSettings");
const channelActiveTradeParams_1 = require("./channelActiveTradeParams");
const tpBucketDistribution_1 = require("./manualPlanning/tpBucketDistribution");
const orderModifyBenign_1 = require("./orderModifyBenign");
function isParameterRefreshParsed(parsed) {
    if (!parsed)
        return false;
    const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0;
    const hasTp = Array.isArray(parsed.tp)
        && parsed.tp.some(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
    if (!hasSl && !hasTp)
        return false;
    const act = String(parsed.action ?? '').toLowerCase();
    return act === 'buy' || act === 'sell' || act === 'modify';
}
function sanitizeLevel(v) {
    const n = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
function positiveTps(parsed) {
    return (parsed?.tp ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
}
function symbolsCompatibleForBasket(signalSym, brokerSym) {
    const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const a = norm(String(signalSym ?? ''));
    const b = norm(String(brokerSym ?? ''));
    if (!a.length || !b.length)
        return false;
    return a === b || b.includes(a) || a.includes(b);
}
/**
 * When a virtual range leg fills after an SL/TP (or breakeven) message was already
 * processed for the basket, apply the newest matching management instruction to this
 * position immediately (do not wait for the trade-executor sweep).
 */
async function tryApplyBasketFollowUpToNewFill(supabase, api, args) {
    const { data: basket } = await supabase
        .from('signals')
        .select('channel_id, created_at, parsed_data')
        .eq('id', args.basketSignalId)
        .maybeSingle();
    const channelId = basket?.channel_id;
    const createdAt = basket?.created_at;
    const anchorParsed = basket?.parsed_data;
    if (!channelId || !createdAt)
        return;
    let tpLots = args.tpLots;
    if (tpLots === undefined) {
        const { data: br } = await supabase
            .from('broker_accounts')
            .select('manual_settings')
            .eq('id', args.brokerAccountId)
            .maybeSingle();
        tpLots = (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(br?.manual_settings).tp_lots;
    }
    const { data: openLegs } = await supabase
        .from('trades')
        .select('id')
        .eq('broker_account_id', args.brokerAccountId)
        .eq('signal_id', args.basketSignalId)
        .eq('status', 'open')
        .order('opened_at', { ascending: true })
        .limit(500);
    const legIndex = (openLegs ?? []).findIndex(r => r.id === args.tradeRowId);
    const { data: pendingRows } = await supabase
        .from('range_pending_legs')
        .select('step_idx')
        .eq('broker_account_id', args.brokerAccountId)
        .eq('signal_id', args.basketSignalId)
        .in('status', ['pending', 'claimed'])
        .limit(500);
    const openCount = openLegs?.length ?? 0;
    const activePendingCount = pendingRows?.length ?? 0;
    const maxPendingStepIdx = Math.max(0, ...(pendingRows ?? []).map(r => Number(r.step_idx) || 0));
    const totalPlannedLegs = (0, channelActiveTradeParams_1.estimateBasketTotalPlannedLegs)({
        openLegCount: openCount,
        activePendingCount,
        maxPendingStepIdx,
    });
    const firedPendingApprox = Math.max(0, maxPendingStepIdx - activePendingCount);
    const immediateLegCount = Math.max(0, openCount - firedPendingApprox);
    const rangeLegCount = Math.max(0, totalPlannedLegs - immediateLegCount);
    const { data: candidates } = await supabase
        .from('signals')
        .select('id, parsed_data, created_at, is_modification')
        .eq('user_id', args.userId)
        .eq('channel_id', channelId)
        .in('status', ['parsed', 'executed'])
        .gte('created_at', createdAt)
        .order('created_at', { ascending: false })
        .limit(60);
    for (const row of candidates ?? []) {
        const parsed = row.parsed_data;
        if (!parsed?.action)
            continue;
        const act = String(parsed.action).toLowerCase();
        const paramRefresh = isParameterRefreshParsed(parsed);
        if (act !== 'modify' && act !== 'breakeven' && !paramRefresh)
            continue;
        if (!symbolsCompatibleForBasket(parsed.symbol, args.symbol))
            continue;
        let stoploss = 0;
        let takeprofit = 0;
        let dbPatch = {};
        if (act === 'modify' || paramRefresh) {
            const hasNewSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0;
            const signalTps = positiveTps(parsed);
            const anchorTps = positiveTps(anchorParsed);
            const finalTps = signalTps.length ? signalTps : anchorTps;
            const hasNewTp = finalTps.length > 0;
            if (!hasNewSl && !hasNewTp)
                continue;
            stoploss = hasNewSl ? parsed.sl : sanitizeLevel(args.existingSl);
            if (hasNewTp) {
                const idx = legIndex >= 0 ? legIndex : openCount - 1;
                takeprofit = (0, tpBucketDistribution_1.takeProfitForSplitBasketLeg)({
                    legIndex: idx,
                    immediateLegCount,
                    rangeLegCount,
                    finalTps,
                    tpLots,
                });
                if (takeprofit <= 0) {
                    takeprofit = finalTps[finalTps.length - 1];
                }
            }
            else {
                takeprofit = sanitizeLevel(args.existingTp);
            }
            if (hasNewSl)
                dbPatch.sl = parsed.sl;
            if (hasNewTp && takeprofit > 0)
                dbPatch.tp = takeprofit;
        }
        else {
            const entry = sanitizeLevel(args.entryPrice);
            if (entry <= 0)
                continue;
            stoploss = entry;
            takeprofit = sanitizeLevel(args.existingTp);
            dbPatch.sl = entry;
        }
        try {
            await api.orderModify(args.metaUuid, {
                ticket: args.ticket,
                stoploss,
                takeprofit,
            });
            if (Object.keys(dbPatch).length > 0) {
                await supabase.from('trades').update(dbPatch).eq('id', args.tradeRowId);
            }
            await supabase.from('trade_execution_logs').insert({
                user_id: args.userId,
                signal_id: row.id,
                broker_account_id: args.brokerAccountId,
                action: 'mgmt_range_leg_followup',
                status: 'success',
                request_payload: {
                    ticket: args.ticket,
                    trade_id: args.tradeRowId,
                    leg_index: legIndex >= 0 ? legIndex + 1 : null,
                    stoploss,
                    takeprofit,
                    basket_signal_id: args.basketSignalId,
                },
            });
            return;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const benign = (0, orderModifyBenign_1.isBenignOrderModifyError)(msg);
            await supabase.from('trade_execution_logs').insert({
                user_id: args.userId,
                signal_id: row.id,
                broker_account_id: args.brokerAccountId,
                action: 'mgmt_range_leg_followup',
                status: benign ? 'success' : 'failed',
                error_message: benign ? null : msg,
                request_payload: {
                    ticket: args.ticket,
                    trade_id: args.tradeRowId,
                    basket_signal_id: args.basketSignalId,
                },
            });
        }
    }
}
