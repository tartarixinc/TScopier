"use strict";
/**
 * Listener-side publisher: enqueue parsed signals to shard-scoped Redis Streams.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseQueueJobFields = parseQueueJobFields;
exports.enqueueParsedSignal = enqueueParsedSignal;
const tradeSignalActions_1 = require("../tradeSignalActions");
const redisStreamsClient_1 = require("./redisStreamsClient");
const signalQueueConfig_1 = require("./signalQueueConfig");
const signalQueueRetry_1 = require("./signalQueueRetry");
const workerMetrics_1 = require("../workerMetrics");
function buildJob(row, lane) {
    const action = (0, tradeSignalActions_1.parsedAction)(row.parsed_data);
    const shardId = (0, signalQueueConfig_1.tradeShardForUser)(row.user_id);
    return {
        signal_id: row.id,
        user_id: row.user_id,
        channel_id: row.channel_id,
        action_class: action,
        priority: (0, tradeSignalActions_1.dispatchPriorityForAction)(action),
        shard_id: shardId,
        lane,
        idempotency_key: (0, signalQueueConfig_1.buildIdempotencyKey)({
            signalId: row.id,
            userId: row.user_id,
            actionClass: action,
        }),
        attempts: 1,
        enqueued_at: Date.now(),
        pipeline_ts: row.pipeline_ts,
        signal: row,
    };
}
function serializeJob(job) {
    return {
        signal_id: job.signal_id,
        user_id: job.user_id,
        channel_id: job.channel_id ?? '',
        action_class: job.action_class,
        priority: job.priority,
        shard_id: String(job.shard_id),
        lane: job.lane,
        idempotency_key: job.idempotency_key,
        attempts: String(job.attempts),
        enqueued_at: String(job.enqueued_at),
        pipeline_ts: JSON.stringify(job.pipeline_ts ?? {}),
        payload: JSON.stringify(job.signal),
    };
}
function parseQueueJobFields(fields) {
    try {
        const signalRaw = fields.payload;
        if (!signalRaw)
            return null;
        const signal = JSON.parse(signalRaw);
        const lane = (fields.lane === 'mgmt' ? 'mgmt' : 'entry');
        let pipeline_ts;
        if (fields.pipeline_ts) {
            try {
                pipeline_ts = JSON.parse(fields.pipeline_ts);
            }
            catch {
                pipeline_ts = undefined;
            }
        }
        return {
            signal_id: fields.signal_id ?? signal.id,
            user_id: fields.user_id ?? signal.user_id,
            channel_id: fields.channel_id || signal.channel_id || null,
            action_class: fields.action_class ?? (0, tradeSignalActions_1.parsedAction)(signal.parsed_data),
            priority: fields.priority === 'normal' ? 'normal' : 'high',
            shard_id: Math.floor(Number(fields.shard_id ?? 0)),
            lane,
            idempotency_key: fields.idempotency_key ?? (0, signalQueueConfig_1.buildIdempotencyKey)({
                signalId: signal.id,
                userId: signal.user_id,
                actionClass: (0, tradeSignalActions_1.parsedAction)(signal.parsed_data),
            }),
            attempts: Math.max(1, Math.floor(Number(fields.attempts ?? 1))),
            enqueued_at: Math.floor(Number(fields.enqueued_at ?? Date.now())),
            pipeline_ts,
            signal,
        };
    }
    catch {
        return null;
    }
}
async function enqueueParsedSignal(supabase, row) {
    if (!(0, signalQueueConfig_1.shouldEnqueueForUser)(row.user_id)) {
        return { ok: false, skipped: true, reason: 'queue_not_enabled_for_user' };
    }
    const lane = (0, signalQueueConfig_1.queueLaneForParsed)(row.parsed_data);
    if (!lane) {
        return { ok: false, skipped: true, reason: 'no_queue_lane_for_action' };
    }
    const shardId = (0, signalQueueConfig_1.tradeShardForUser)(row.user_id);
    const streamKey = (0, signalQueueConfig_1.streamKeyForLane)(lane, shardId);
    const job = buildJob(row, lane);
    const startedAt = Date.now();
    try {
        const messageId = await (0, redisStreamsClient_1.xadd)(streamKey, serializeJob(job));
        (0, workerMetrics_1.incMetric)('queue_enqueue_ok');
        const enqueueMs = Date.now() - startedAt;
        void (0, signalQueueRetry_1.logQueueExecution)(supabase, {
            user_id: row.user_id,
            signal_id: row.id,
            action: 'dispatch_enqueue_attempt',
            status: 'success',
            request_payload: {
                stream_key: streamKey,
                message_id: messageId,
                lane,
                shard_id: shardId,
                action_class: job.action_class,
                priority: job.priority,
                idempotency_key: job.idempotency_key,
                enqueue_ms: enqueueMs,
            },
        });
        return { ok: true, streamKey, messageId, lane, shardId };
    }
    catch (err) {
        (0, workerMetrics_1.incMetric)('queue_enqueue_failed');
        const msg = err instanceof Error ? err.message : String(err);
        void (0, signalQueueRetry_1.logQueueExecution)(supabase, {
            user_id: row.user_id,
            signal_id: row.id,
            action: 'dispatch_enqueue_failed',
            status: 'failed',
            request_payload: {
                stream_key: streamKey,
                lane,
                shard_id: shardId,
                action_class: job.action_class,
                error: msg.slice(0, 300),
                enqueue_ms: Date.now() - startedAt,
            },
        });
        console.warn(`[signalQueue] enqueue failed signal=${row.id} user=${row.user_id} stream=${streamKey}: ${msg}`);
        return { ok: false, streamKey, lane, shardId, error: msg };
    }
}
