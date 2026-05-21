"use strict";
/**
 * Dead-letter replay hooks for signal queue jobs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listReplayableDeadLetters = listReplayableDeadLetters;
exports.replayDeadLetterToStream = replayDeadLetterToStream;
exports.replayDeadLetterInProcess = replayDeadLetterInProcess;
const redisStreamsClient_1 = require("./redisStreamsClient");
const signalQueueConfig_1 = require("./signalQueueConfig");
const signalQueueConfig_2 = require("./signalQueueConfig");
const tradeSignalActions_1 = require("../tradeSignalActions");
async function listReplayableDeadLetters(supabase, limit = 50) {
    const { data, error } = await supabase
        .from('signal_queue_dead_letters')
        .select('*')
        .eq('status', 'dead')
        .order('created_at', { ascending: true })
        .limit(limit);
    if (error) {
        throw new Error(`listReplayableDeadLetters: ${error.message}`);
    }
    return (data ?? []);
}
async function replayDeadLetterToStream(supabase, row) {
    const lane = (row.lane === 'mgmt' ? 'mgmt' : 'entry');
    const streamKey = (0, signalQueueConfig_1.streamKeyForLane)(lane, row.shard_id);
    const signal = row.payload;
    const action = (0, tradeSignalActions_1.parsedAction)(signal.parsed_data);
    try {
        const messageId = await (0, redisStreamsClient_1.xadd)(streamKey, {
            signal_id: row.signal_id,
            user_id: row.user_id,
            channel_id: signal.channel_id ?? '',
            action_class: action,
            priority: 'normal',
            shard_id: String(row.shard_id),
            lane,
            idempotency_key: (0, signalQueueConfig_2.buildIdempotencyKey)({
                signalId: row.signal_id,
                userId: row.user_id,
                actionClass: `${action}:replay:${row.id}`,
            }),
            attempts: '1',
            enqueued_at: String(Date.now()),
            pipeline_ts: JSON.stringify(signal.pipeline_ts ?? {}),
            payload: JSON.stringify(signal),
            replay_of_dlq_id: row.id,
        });
        const { error } = await supabase
            .from('signal_queue_dead_letters')
            .update({ status: 'replayed', replayed_at: new Date().toISOString() })
            .eq('id', row.id);
        if (error) {
            return { ok: false, error: error.message };
        }
        return { ok: true, messageId };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
}
/** In-process replay: push DLQ payload directly to executor (ops tooling). */
function replayDeadLetterInProcess(tradeExecutor, row) {
    const signal = row.payload;
    const signalRow = signal;
    return tradeExecutor.acceptDispatchSignal(signalRow, {
        priority: 'normal',
        source: 'dlq_replay',
    });
}
