"use strict";
/**
 * Shard-aware Redis Streams consumer for trade_entry / trade_mgmt workers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalQueueConsumerManager = exports.SignalQueueConsumer = void 0;
const workerConfig_1 = require("../workerConfig");
const workerMetrics_1 = require("../workerMetrics");
const redisStreamsClient_1 = require("./redisStreamsClient");
const signalQueueConfig_1 = require("./signalQueueConfig");
const signalQueueIdempotency_1 = require("./signalQueueIdempotency");
const signalQueuePublisher_1 = require("./signalQueuePublisher");
const signalQueueRetry_1 = require("./signalQueueRetry");
class SignalQueueConsumer {
    constructor(supabase, tradeExecutor, lane) {
        this.supabase = supabase;
        this.tradeExecutor = tradeExecutor;
        this.lane = lane;
        this.stopped = false;
        this.readLoopPromise = null;
        this.reclaimLoopPromise = null;
        this.reclaimCursor = '0-0';
        this.lastReadAt = null;
        this.lastAckAt = null;
        this.lastError = null;
    }
    static lanesForWorker() {
        const lanes = [];
        if ((0, signalQueueConfig_1.shouldConsumeQueueLane)('entry'))
            lanes.push('entry');
        if ((0, signalQueueConfig_1.shouldConsumeQueueLane)('mgmt'))
            lanes.push('mgmt');
        return lanes;
    }
    start() {
        if (this.readLoopPromise)
            return;
        this.stopped = false;
        const streamKey = (0, signalQueueConfig_1.streamKeyForLane)(this.lane, workerConfig_1.workerConfig.shardId);
        const group = (0, signalQueueConfig_1.consumerGroupForLane)(this.lane, workerConfig_1.workerConfig.shardId);
        void (0, redisStreamsClient_1.xgroupCreateMkStream)(streamKey, group).catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[signalQueue] XGROUP CREATE failed stream=${streamKey}: ${msg}`);
        });
        this.readLoopPromise = this.readLoop();
        this.reclaimLoopPromise = this.reclaimLoop();
        console.log(`[signalQueue] consumer started lane=${this.lane} shard=${workerConfig_1.workerConfig.shardId}`
            + ` stream=${streamKey} group=${group}`);
    }
    async stop() {
        this.stopped = true;
        await Promise.allSettled([this.readLoopPromise, this.reclaimLoopPromise]);
        this.readLoopPromise = null;
        this.reclaimLoopPromise = null;
    }
    async getMetrics() {
        const streamKey = (0, signalQueueConfig_1.streamKeyForLane)(this.lane, workerConfig_1.workerConfig.shardId);
        const group = (0, signalQueueConfig_1.consumerGroupForLane)(this.lane, workerConfig_1.workerConfig.shardId);
        let streamLength = 0;
        let pending = 0;
        try {
            streamLength = await (0, redisStreamsClient_1.xlen)(streamKey);
            const summary = await (0, redisStreamsClient_1.xpendingSummary)(streamKey, group);
            pending = summary.pending;
        }
        catch {
            /* best-effort */
        }
        return {
            lane: this.lane,
            stream_key: streamKey,
            stream_length: streamLength,
            pending,
            last_read_at: this.lastReadAt ? new Date(this.lastReadAt).toISOString() : null,
            last_ack_at: this.lastAckAt ? new Date(this.lastAckAt).toISOString() : null,
            last_error: this.lastError,
        };
    }
    consumerName() {
        return `${workerConfig_1.workerConfig.instanceId}:${this.lane}`;
    }
    async readLoop() {
        const cfg = (0, signalQueueConfig_1.signalQueueConfig)();
        const blockMs = this.lane === 'mgmt' ? cfg.mgmtConsumerBlockMs : cfg.consumerBlockMs;
        const streamKey = (0, signalQueueConfig_1.streamKeyForLane)(this.lane, workerConfig_1.workerConfig.shardId);
        const group = (0, signalQueueConfig_1.consumerGroupForLane)(this.lane, workerConfig_1.workerConfig.shardId);
        const consumer = this.consumerName();
        while (!this.stopped) {
            try {
                const messages = await (0, redisStreamsClient_1.xreadgroup)(group, consumer, streamKey, cfg.readCount, blockMs);
                this.lastReadAt = Date.now();
                if (messages.length === 0)
                    continue;
                await mapConcurrent(messages, cfg.consumerConcurrency, msg => this.processMessage(streamKey, group, msg));
            }
            catch (err) {
                this.lastError = err instanceof Error ? err.message : String(err);
                (0, workerMetrics_1.incMetric)('queue_consumer_read_errors');
                console.warn(`[signalQueue] read error lane=${this.lane}: ${this.lastError}`);
                await sleep(Math.min(5000, blockMs));
            }
        }
    }
    async reclaimLoop() {
        const cfg = (0, signalQueueConfig_1.signalQueueConfig)();
        const streamKey = (0, signalQueueConfig_1.streamKeyForLane)(this.lane, workerConfig_1.workerConfig.shardId);
        const group = (0, signalQueueConfig_1.consumerGroupForLane)(this.lane, workerConfig_1.workerConfig.shardId);
        const consumer = this.consumerName();
        const intervalMs = Math.max(5000, Math.floor(cfg.claimIdleMs / 3));
        while (!this.stopped) {
            await sleep(intervalMs);
            if (this.stopped)
                break;
            try {
                const { nextStart, messages } = await (0, redisStreamsClient_1.xautoclaim)(streamKey, group, consumer, cfg.claimIdleMs, this.reclaimCursor, cfg.readCount);
                this.reclaimCursor = nextStart;
                if (messages.length === 0)
                    continue;
                (0, workerMetrics_1.incMetric)('queue_reclaimed', messages.length);
                await mapConcurrent(messages, cfg.consumerConcurrency, msg => this.processMessage(streamKey, group, msg, { reclaimed: true }));
            }
            catch (err) {
                this.lastError = err instanceof Error ? err.message : String(err);
                (0, workerMetrics_1.incMetric)('queue_consumer_reclaim_errors');
                console.warn(`[signalQueue] reclaim error lane=${this.lane}: ${this.lastError}`);
            }
        }
    }
    async processMessage(streamKey, group, msg, opts) {
        const job = (0, signalQueuePublisher_1.parseQueueJobFields)(msg.fields);
        if (!job) {
            (0, workerMetrics_1.incMetric)('queue_malformed');
            await (0, redisStreamsClient_1.xack)(streamKey, group, msg.id);
            return;
        }
        const attempts = (0, signalQueueRetry_1.parseAttemptCount)(msg.fields);
        const enqueueToStartMs = Date.now() - job.enqueued_at;
        const claimed = await (0, signalQueueIdempotency_1.claimQueueIdempotency)(this.supabase, job.idempotency_key, {
            signal_id: job.signal_id,
            user_id: job.user_id,
            lane: job.lane,
        });
        if (!claimed) {
            (0, workerMetrics_1.incMetric)('queue_duplicate_skip');
            await (0, redisStreamsClient_1.xack)(streamKey, group, msg.id);
            this.lastAckAt = Date.now();
            return;
        }
        const receivedAt = Date.now();
        const signalRow = {
            ...job.signal,
            pipeline_ts: {
                ...(job.pipeline_ts ?? {}),
                t_dispatch_received: receivedAt,
            },
        };
        void (0, signalQueueRetry_1.logQueueExecution)(this.supabase, {
            user_id: job.user_id,
            signal_id: job.signal_id,
            action: 'queue_consume_start',
            status: 'success',
            request_payload: {
                message_id: msg.id,
                lane: job.lane,
                shard_id: job.shard_id,
                attempts,
                enqueue_to_start_ms: enqueueToStartMs,
                reclaimed: opts?.reclaimed === true,
            },
        });
        try {
            const accepted = await this.tradeExecutor.acceptDispatchSignalAwait(signalRow, {
                priority: job.priority,
                source: 'queue',
            });
            if (!accepted) {
                throw new Error('trade_executor_rejected_signal');
            }
            await (0, redisStreamsClient_1.xack)(streamKey, group, msg.id);
            this.lastAckAt = Date.now();
            (0, workerMetrics_1.incMetric)('queue_consume_ok');
            void (0, signalQueueRetry_1.logQueueExecution)(this.supabase, {
                user_id: job.user_id,
                signal_id: job.signal_id,
                action: 'queue_consume_ack',
                status: 'success',
                request_payload: {
                    message_id: msg.id,
                    enqueue_to_ack_ms: Date.now() - job.enqueued_at,
                },
            });
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.lastError = reason;
            (0, workerMetrics_1.incMetric)('queue_consume_failed');
            if (!(0, signalQueueRetry_1.shouldRetryAfterFailure)(attempts)) {
                (0, workerMetrics_1.incMetric)('queue_dlq');
                await (0, signalQueueRetry_1.persistDeadLetter)(this.supabase, {
                    stream_key: streamKey,
                    message_id: msg.id,
                    idempotency_key: job.idempotency_key,
                    signal_id: job.signal_id,
                    user_id: job.user_id,
                    lane: job.lane,
                    shard_id: job.shard_id,
                    attempts,
                    reason,
                    payload: job.signal,
                });
                await (0, redisStreamsClient_1.xack)(streamKey, group, msg.id);
                void (0, signalQueueRetry_1.logQueueExecution)(this.supabase, {
                    user_id: job.user_id,
                    signal_id: job.signal_id,
                    action: 'queue_dead_letter',
                    status: 'failed',
                    request_payload: {
                        message_id: msg.id,
                        attempts,
                        reason: reason.slice(0, 200),
                    },
                });
                return;
            }
            void (0, signalQueueRetry_1.logQueueExecution)(this.supabase, {
                user_id: job.user_id,
                signal_id: job.signal_id,
                action: 'queue_consume_retry',
                status: 'failed',
                request_payload: {
                    message_id: msg.id,
                    attempts,
                    next_attempt: attempts + 1,
                    reason: reason.slice(0, 200),
                    backoff_ms: (0, signalQueueRetry_1.retryBackoffMs)(attempts),
                    reclaimed: opts?.reclaimed === true,
                },
            });
            // Leave unacked — XAUTOCLAIM will retry after claim idle timeout.
        }
    }
}
exports.SignalQueueConsumer = SignalQueueConsumer;
async function mapConcurrent(items, limit, fn) {
    if (items.length === 0)
        return;
    const pool = Math.max(1, Math.min(limit, items.length));
    let idx = 0;
    await Promise.all(Array.from({ length: pool }, async () => {
        while (idx < items.length) {
            const i = idx++;
            await fn(items[i]);
        }
    }));
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
class SignalQueueConsumerManager {
    constructor(supabase, tradeExecutor) {
        this.supabase = supabase;
        this.tradeExecutor = tradeExecutor;
        this.consumers = [];
    }
    start() {
        if (this.consumers.length > 0)
            return;
        for (const lane of SignalQueueConsumer.lanesForWorker()) {
            const consumer = new SignalQueueConsumer(this.supabase, this.tradeExecutor, lane);
            consumer.start();
            this.consumers.push(consumer);
        }
    }
    async stop() {
        await Promise.all(this.consumers.map(c => c.stop()));
        this.consumers = [];
    }
    async getMetrics() {
        return Promise.all(this.consumers.map(c => c.getMetrics()));
    }
}
exports.SignalQueueConsumerManager = SignalQueueConsumerManager;
