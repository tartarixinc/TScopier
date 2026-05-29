"use strict";
/**
 * Redis Streams queue configuration for listener → trade dispatch.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueShardCount = queueShardCount;
exports.loadSignalQueueConfig = loadSignalQueueConfig;
exports.signalQueueConfig = signalQueueConfig;
exports.resetSignalQueueConfigCache = resetSignalQueueConfigCache;
exports.redisQueueConfigured = redisQueueConfigured;
exports.queueLaneForParsed = queueLaneForParsed;
exports.streamKeyForLane = streamKeyForLane;
exports.consumerGroupForLane = consumerGroupForLane;
exports.tradeShardForUser = tradeShardForUser;
exports.shouldEnqueueForUser = shouldEnqueueForUser;
exports.shouldConsumeQueueLane = shouldConsumeQueueLane;
exports.deployedTradeShardCount = deployedTradeShardCount;
exports.buildIdempotencyKey = buildIdempotencyKey;
const tradeSignalActions_1 = require("../tradeSignalActions");
const workerConfig_1 = require("../workerConfig");
function parseEnvBool(raw, defaultValue) {
    if (raw === undefined || raw === '')
        return defaultValue;
    const v = raw.toLowerCase().trim();
    if (v === '0' || v === 'false' || v === 'no')
        return false;
    if (v === '1' || v === 'true' || v === 'yes')
        return true;
    return defaultValue;
}
function parseCanaryShards(raw) {
    if (!raw?.trim())
        return null;
    const ids = raw.split(',').map(s => Math.floor(Number(s.trim()))).filter(n => Number.isFinite(n) && n >= 0);
    return ids.length > 0 ? new Set(ids) : null;
}
function queueShardCount() {
    const raw = process.env.TRADE_SIGNAL_QUEUE_SHARD_COUNT
        ?? process.env.TRADE_WORKER_SHARD_COUNT
        ?? process.env.WORKER_SHARD_COUNT
        ?? '1';
    return Math.max(1, Math.floor(Number(raw)));
}
function loadSignalQueueConfig() {
    return {
        enabled: parseEnvBool(process.env.TRADE_SIGNAL_QUEUE_ENABLED, false),
        canaryShardIds: parseCanaryShards(process.env.TRADE_SIGNAL_QUEUE_CANARY_SHARDS),
        entryStreamBase: String(process.env.TRADE_SIGNAL_QUEUE_ENTRY_STREAM ?? 'signals:entry').trim(),
        mgmtStreamBase: String(process.env.TRADE_SIGNAL_QUEUE_MGMT_STREAM ?? 'signals:mgmt').trim(),
        consumerBlockMs: Math.max(100, Math.min(30000, Number(process.env.TRADE_SIGNAL_QUEUE_CONSUMER_BLOCK_MS ?? 2000))),
        mgmtConsumerBlockMs: Math.max(100, Math.min(5000, Number(process.env.TRADE_SIGNAL_QUEUE_MGMT_CONSUMER_BLOCK_MS ?? 500))),
        claimIdleMs: Math.max(5000, Math.min(600000, Number(process.env.TRADE_SIGNAL_QUEUE_CLAIM_IDLE_MS ?? 60000))),
        maxAttempts: Math.max(1, Math.min(20, Number(process.env.TRADE_SIGNAL_QUEUE_MAX_ATTEMPTS ?? 5))),
        readCount: Math.max(1, Math.min(100, Number(process.env.TRADE_SIGNAL_QUEUE_READ_COUNT ?? 10))),
        shardCount: queueShardCount(),
        consumerConcurrency: Math.max(1, Math.min(32, Number(process.env.TRADE_SIGNAL_QUEUE_CONSUMER_CONCURRENCY
            ?? process.env.EXECUTOR_MAX_CONCURRENT_SIGNALS
            ?? 8))),
        pushFallbackOnQueueFail: parseEnvBool(process.env.TRADE_SIGNAL_PUSH_FALLBACK_ON_QUEUE_FAIL, true),
        redisRestUrl: String(process.env.UPSTASH_REDIS_REST_URL ?? process.env.REDIS_REST_URL ?? '').trim(),
        redisRestToken: String(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.REDIS_REST_TOKEN ?? '').trim(),
    };
}
let cachedConfig = null;
function signalQueueConfig() {
    if (!cachedConfig)
        cachedConfig = loadSignalQueueConfig();
    return cachedConfig;
}
/** Reset cached config (tests). */
function resetSignalQueueConfigCache() {
    cachedConfig = null;
}
function redisQueueConfigured() {
    const cfg = signalQueueConfig();
    return Boolean(cfg.redisRestUrl && cfg.redisRestToken);
}
function queueLaneForParsed(parsed) {
    const action = (0, tradeSignalActions_1.parsedAction)(parsed);
    if (!action || action === 'ignore')
        return null;
    if ((0, tradeSignalActions_1.isManagementAction)(action))
        return 'mgmt';
    if ((0, tradeSignalActions_1.isEntryAction)(action))
        return 'entry';
    return null;
}
function streamKeyForLane(lane, shardId) {
    const cfg = signalQueueConfig();
    const base = lane === 'entry' ? cfg.entryStreamBase : cfg.mgmtStreamBase;
    return `${base}:${shardId}`;
}
function consumerGroupForLane(lane, shardId) {
    return `${lane}-shard-${shardId}`;
}
function tradeShardForUser(userId) {
    return (0, workerConfig_1.shardForUserId)(userId, signalQueueConfig().shardCount);
}
function shouldEnqueueForUser(userId) {
    const cfg = signalQueueConfig();
    if (!cfg.enabled || !redisQueueConfigured())
        return false;
    const shard = tradeShardForUser(userId);
    if (cfg.canaryShardIds && !cfg.canaryShardIds.has(shard))
        return false;
    return true;
}
function shouldConsumeQueueLane(lane) {
    const cfg = signalQueueConfig();
    if (!cfg.enabled || !redisQueueConfigured())
        return false;
    if (!workerConfig_1.workerConfig.runsTrade)
        return false;
    if (cfg.canaryShardIds && !cfg.canaryShardIds.has(workerConfig_1.workerConfig.shardId))
        return false;
    const mode = workerConfig_1.workerConfig.tradeExecutorMode;
    if (mode === 'all')
        return true;
    if (lane === 'entry')
        return mode === 'entry';
    if (lane === 'mgmt')
        return mode === 'mgmt';
    return false;
}
function deployedTradeShardCount() {
    const shardUrls = String(process.env.TRADE_WORKER_SHARD_URLS ?? '').trim();
    if (shardUrls) {
        return Math.max(1, shardUrls.split(',').map(s => s.trim()).filter(Boolean).length);
    }
    const raw = process.env.TRADE_WORKER_SHARD_COUNT ?? process.env.WORKER_SHARD_COUNT ?? '1';
    return Math.max(1, Math.floor(Number(raw)));
}
function buildIdempotencyKey(parts) {
    const broker = parts.brokerAccountId?.trim() || '_';
    return `${parts.signalId}:${parts.userId}:${broker}:${parts.actionClass}`;
}
