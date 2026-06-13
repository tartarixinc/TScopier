"use strict";
/**
 * Replay status=parsed signals after a broker MT session recovers from disconnect.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearBrokerSessionBlock = clearBrokerSessionBlock;
exports.replayParsedSignalsForBroker = replayParsedSignalsForBroker;
const brokerChannelFilter_1 = require("./brokerChannelFilter");
const copierPause_1 = require("./copierPause");
const dispatch_1 = require("./tradeExecutor/dispatch");
const types_1 = require("./tradeExecutor/types");
const REPLAY_BATCH_LIMIT = 40;
function clearBrokerSessionBlock(ctx, broker) {
    return ctx.sessionOrderBlocked.delete(broker.id);
}
/**
 * Enqueue recent parsed signals for channels linked to this broker so copy
 * resumes after reconnect without waiting for the next Telegram message.
 */
async function replayParsedSignalsForBroker(ctx, broker) {
    if (!broker.is_active)
        return 0;
    if (await (0, copierPause_1.loadCachedUserCopierPaused)(ctx.supabase, broker.user_id))
        return 0;
    const since = new Date(Date.now() - types_1.EXECUTOR_REPLAY_MAX_AGE_MS).toISOString();
    const { data, error } = await ctx.supabase
        .from('signals')
        .select('id,user_id,channel_id,parsed_data,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id')
        .eq('user_id', broker.user_id)
        .eq('status', 'parsed')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(REPLAY_BATCH_LIMIT);
    if (error) {
        console.warn(`[brokerSignalReplay] load parsed signals failed broker=${broker.id}: ${error.message}`);
        return 0;
    }
    let enqueued = 0;
    for (const row of (data ?? [])) {
        if (!(0, brokerChannelFilter_1.channelMatchesBrokerSignal)(broker, row.channel_id))
            continue;
        if (!(0, dispatch_1.brokerEligibleForSignal)(ctx, broker, row))
            continue;
        if (ctx.inflight.has(row.id) || ctx.queuedIds.has(row.id))
            continue;
        (0, dispatch_1.enqueueSignal)(ctx, row, { source: 'broker_reconnect_replay' });
        enqueued += 1;
    }
    if (enqueued > 0) {
        console.log(`[brokerSignalReplay] broker=${broker.id} re-queued ${enqueued} parsed signal(s) after session recovery`);
    }
    return enqueued;
}
