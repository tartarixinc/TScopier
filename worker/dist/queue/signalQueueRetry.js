"use strict";
/**
 * Retry policy and dead-letter persistence for signal queue jobs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAttemptCount = parseAttemptCount;
exports.shouldRetryAfterFailure = shouldRetryAfterFailure;
exports.retryBackoffMs = retryBackoffMs;
exports.persistDeadLetter = persistDeadLetter;
exports.logQueueExecution = logQueueExecution;
const signalQueueConfig_1 = require("./signalQueueConfig");
function parseAttemptCount(fields) {
    const raw = fields.attempts ?? '1';
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 1 ? n : 1;
}
function shouldRetryAfterFailure(attempts) {
    return attempts < (0, signalQueueConfig_1.signalQueueConfig)().maxAttempts;
}
function retryBackoffMs(attempts) {
    const base = Math.max(50, Number(process.env.TRADE_SIGNAL_QUEUE_RETRY_BASE_MS ?? 250));
    return Math.min(30000, base * attempts);
}
async function persistDeadLetter(supabase, record) {
    const { error } = await supabase.from('signal_queue_dead_letters').insert({
        stream_key: record.stream_key,
        message_id: record.message_id,
        idempotency_key: record.idempotency_key,
        signal_id: record.signal_id,
        user_id: record.user_id,
        lane: record.lane,
        shard_id: record.shard_id,
        attempts: record.attempts,
        reason: record.reason.slice(0, 500),
        payload: record.payload,
        status: 'dead',
    });
    if (error) {
        console.error(`[signalQueue] DLQ insert failed signal=${record.signal_id} user=${record.user_id}: ${error.message}`);
    }
}
async function logQueueExecution(supabase, row) {
    const { error } = await supabase.from('trade_execution_logs').insert(row);
    if (error) {
        console.warn(`[signalQueue] log insert failed action=${row.action}: ${error.message}`);
    }
}
