"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.symbolsCompatibleForBasket = symbolsCompatibleForBasket;
exports.tryApplyBasketFollowUpToNewFill = tryApplyBasketFollowUpToNewFill;
function sanitizeLevel(v) {
    const n = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
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
        .select('channel_id, created_at')
        .eq('id', args.basketSignalId)
        .maybeSingle();
    const channelId = basket?.channel_id;
    const createdAt = basket?.created_at;
    if (!channelId || !createdAt)
        return;
    const { data: candidates } = await supabase
        .from('signals')
        .select('id, parsed_data, created_at')
        .eq('user_id', args.userId)
        .eq('channel_id', channelId)
        .eq('is_modification', true)
        .in('status', ['parsed', 'executed'])
        .gte('created_at', createdAt)
        .order('created_at', { ascending: false })
        .limit(40);
    for (const row of candidates ?? []) {
        const parsed = row.parsed_data;
        if (!parsed?.action)
            continue;
        const act = String(parsed.action).toLowerCase();
        if (act !== 'modify' && act !== 'breakeven')
            continue;
        if (!symbolsCompatibleForBasket(parsed.symbol, args.symbol))
            continue;
        let stoploss = 0;
        let takeprofit = 0;
        let dbPatch = {};
        if (act === 'modify') {
            const hasNewSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0;
            const hasNewTp = Array.isArray(parsed.tp)
                && parsed.tp.length > 0
                && typeof parsed.tp[0] === 'number'
                && Number.isFinite(parsed.tp[0])
                && parsed.tp[0] > 0;
            if (!hasNewSl && !hasNewTp)
                continue;
            stoploss = hasNewSl ? parsed.sl : sanitizeLevel(args.existingSl);
            takeprofit = hasNewTp ? parsed.tp[0] : sanitizeLevel(args.existingTp);
            if (hasNewSl)
                dbPatch.sl = parsed.sl;
            if (hasNewTp)
                dbPatch.tp = parsed.tp[0];
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
                    basket_signal_id: args.basketSignalId,
                    source_mgmt_signal: row.id,
                    release_action: act,
                },
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await supabase.from('trade_execution_logs').insert({
                user_id: args.userId,
                signal_id: row.id,
                broker_account_id: args.brokerAccountId,
                action: 'mgmt_range_leg_followup',
                status: 'failed',
                request_payload: {
                    ticket: args.ticket,
                    trade_id: args.tradeRowId,
                    basket_signal_id: args.basketSignalId,
                    source_mgmt_signal: row.id,
                    release_action: act,
                },
                error_message: msg,
            });
        }
        return;
    }
}
