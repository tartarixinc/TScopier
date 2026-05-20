"use strict";
/**
 * Worker process role and shard configuration (Railway / multi-service deploy).
 *
 * WORKER_ROLE:
 *   all          — monolith (default): listener + trade monitors + backtest HTTP
 *   listener     — Telegram ingest only; profile backfill uses live MTProto client
 *   trade        — TradeExecutor (entries + management) + all monitors
 *   trade_entry  — buy/sell only + execution-side monitors (virtual pending, CWE, …)
 *   trade_mgmt   — management only + reconcile / auto-mgmt monitors
 *   backtest     — Ephemeral Telegram client for backtest sync only
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.workerConfig = void 0;
exports.shardForUserId = shardForUserId;
exports.userBelongsToShard = userBelongsToShard;
exports.listenerWorkerId = listenerWorkerId;
exports.leaseRoleLabel = leaseRoleLabel;
const tradeSignalActions_1 = require("./tradeSignalActions");
function parseRole(raw) {
    const v = String(raw ?? 'all').toLowerCase().trim();
    if (v === 'listener'
        || v === 'trade'
        || v === 'trade_entry'
        || v === 'trade_mgmt'
        || v === 'backtest') {
        return v;
    }
    return 'all';
}
const role = parseRole(process.env.WORKER_ROLE);
const runsTradeRole = role === 'all' || role === 'trade' || role === 'trade_entry' || role === 'trade_mgmt';
exports.workerConfig = {
    role,
    instanceId: String(process.env.WORKER_INSTANCE_ID
        ?? `${process.env.HOSTNAME ?? 'local'}:${process.pid}`),
    shardId: Math.max(0, Math.floor(Number(process.env.WORKER_SHARD_ID ?? 0))),
    shardCount: Math.max(1, Math.floor(Number(process.env.WORKER_SHARD_COUNT ?? 1))),
    runsListener: role === 'all' || role === 'listener',
    runsTrade: runsTradeRole,
    tradeExecutorMode: (0, tradeSignalActions_1.tradeExecutorModeForRole)(role),
    runsExecutionMonitors: role === 'all' || role === 'trade' || role === 'trade_entry',
    runsManagementMonitors: role === 'all' || role === 'trade' || role === 'trade_mgmt',
    runsBacktestHttp: role === 'all' || role === 'backtest',
    /** Backtest uses a short-lived Telegram client, never the live listener connection. */
    backtestUsesEphemeralClient: role !== 'all' || process.env.BACKTEST_EPHEMERAL_CLIENT !== 'false',
    /**
     * Supabase Realtime on `signals` for trade execution. Off by default on split trade
     * workers (`trade_entry` / `trade_mgmt`) — each replica would otherwise execute the
     * same row (in-memory inflight is not shared). Listener HTTP push + sweep remain.
     */
    tradeExecutorRealtime: parseEnvBool(process.env.EXECUTOR_REALTIME_SIGNALS, role === 'all' || role === 'trade'),
};
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
function shardForUserId(userId, shardCount) {
    let h = 0;
    for (let i = 0; i < userId.length; i++) {
        h = (h * 31 + userId.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % Math.max(1, shardCount);
}
function userBelongsToShard(userId) {
    if (exports.workerConfig.shardCount <= 1)
        return true;
    return shardForUserId(userId, exports.workerConfig.shardCount) === exports.workerConfig.shardId;
}
function listenerWorkerId() {
    return `listener:${exports.workerConfig.shardId}:${exports.workerConfig.instanceId}`;
}
function leaseRoleLabel() {
    if (exports.workerConfig.role === 'listener')
        return 'listener';
    if (exports.workerConfig.role === 'all')
        return 'listener';
    return exports.workerConfig.role;
}
