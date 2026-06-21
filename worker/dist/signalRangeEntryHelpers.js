"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitRowToPlannerWait = exports.SIGNAL_RANGE_WAKE_DISPATCH_SOURCE = void 0;
exports.upsertSignalRangeEntryWait = upsertSignalRangeEntryWait;
exports.markSignalRangeEntryFired = markSignalRangeEntryFired;
exports.hasActiveSignalRangeEntryWait = hasActiveSignalRangeEntryWait;
exports.cancelSignalRangeEntryWaitsForSignal = cancelSignalRangeEntryWaitsForSignal;
exports.logSignalRangeEntryNoPrice = logSignalRangeEntryNoPrice;
exports.logSignalRangeEntryWaiting = logSignalRangeEntryWaiting;
exports.logSignalRangeEntryFired = logSignalRangeEntryFired;
exports.logSignalRangeEntryWakeRetry = logSignalRangeEntryWakeRetry;
const signalRangeEntryService_1 = require("./signalRangeEntryService");
exports.SIGNAL_RANGE_WAKE_DISPATCH_SOURCE = 'signal_range_wake';
var signalRangeEntryService_2 = require("./signalRangeEntryService");
Object.defineProperty(exports, "waitRowToPlannerWait", { enumerable: true, get: function () { return signalRangeEntryService_2.waitRowToPlannerWait; } });
async function upsertSignalRangeEntryWait(supabase, args) {
    const parsed = args.parsed ?? args.signal.parsed_data;
    if (!parsed)
        return;
    await (0, signalRangeEntryService_1.syncWaitRow)(supabase, {
        signal: args.signal,
        broker: args.broker,
        uuid: args.uuid,
        symbol: args.symbol,
        parsed,
        manual: args.manual,
        preserveExpiresAt: args.preserveExpiresAt ?? true,
        logUpdates: false,
    });
}
async function markSignalRangeEntryFired(supabase, signalId, brokerAccountId) {
    await supabase
        .from('signal_range_entry_waits')
        .update({ status: 'fired', updated_at: new Date().toISOString() })
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId)
        .in('status', ['waiting', 'fired']);
}
async function hasActiveSignalRangeEntryWait(supabase, signalId) {
    const { count, error } = await supabase
        .from('signal_range_entry_waits')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('status', 'waiting');
    if (error) {
        console.warn(`[signalRangeEntry] hasActiveWait failed signal=${signalId}: ${error.message}`);
        return false;
    }
    return (count ?? 0) > 0;
}
async function cancelSignalRangeEntryWaitsForSignal(supabase, signalId, brokerAccountId, reason = 'basket_opened') {
    let q = supabase
        .from('signal_range_entry_waits')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('signal_id', signalId)
        .eq('status', 'waiting');
    if (brokerAccountId)
        q = q.eq('broker_account_id', brokerAccountId);
    const { error } = await q;
    if (error) {
        console.warn(`[signalRangeEntry] cancel waits failed signal=${signalId} reason=${reason}: ${error.message}`);
    }
}
async function logSignalRangeEntryNoPrice(supabase, signal, broker, parsed, symbol) {
    try {
        await supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'signal_range_entry_no_price',
            status: 'skipped',
            request_payload: {
                direction: String(parsed.action ?? '').toLowerCase(),
                symbol,
            },
        });
    }
    catch {
        /* best-effort */
    }
}
async function logSignalRangeEntryWaiting(supabase, signal, broker, wait, symbol, bid, ask) {
    try {
        await supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'signal_range_entry_waiting',
            status: 'success',
            request_payload: {
                direction: wait.isBuy ? 'buy' : 'sell',
                symbol,
                entry_price: wait.entryPrice,
                zone_lo: wait.zoneLo,
                zone_hi: wait.zoneHi,
                tolerance_pips: wait.tolerancePips,
                bid,
                ask,
            },
        });
    }
    catch {
        /* best-effort */
    }
}
async function logSignalRangeEntryFired(supabase, signal, brokerAccountId, wait, symbol) {
    try {
        await supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: brokerAccountId,
            action: 'signal_range_entry_fired',
            status: 'success',
            request_payload: {
                direction: wait.isBuy ? 'buy' : 'sell',
                symbol,
                entry_price: wait.entryPrice,
                zone_lo: wait.zoneLo,
                zone_hi: wait.zoneHi,
                tolerance_pips: wait.tolerancePips,
            },
        });
    }
    catch {
        /* best-effort */
    }
}
async function logSignalRangeEntryWakeRetry(supabase, signal, brokerAccountId, symbol, bid, ask) {
    try {
        await supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: brokerAccountId,
            action: 'signal_range_entry_wake_retry',
            status: 'success',
            request_payload: { symbol, bid, ask },
        });
    }
    catch {
        /* best-effort */
    }
}
