"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXECUTION_LOG_ACTIONS_HANDLED = exports.EXECUTOR_MAX_CONCURRENT_SIGNALS = exports.EXECUTOR_REPLAY_MAX_AGE_MS = exports.EXECUTOR_SWEEP_IDLE_MS = exports.EXECUTOR_PARSED_SWEEP_MS = exports.SESSION_PING_MIN_INTERVAL_MS = exports.BROKER_SESSION_HEARTBEAT_MS = exports.SYMBOL_CACHE_KEEPALIVE_MS = exports.SYMBOL_CACHE_STALE_MS = exports.SYMBOL_LIST_TTL_MS = exports.SYMBOL_CACHE_TTL_MS = exports.PARSED_STATUSES = void 0;
exports.telegramLiveTradeGateEnabled = telegramLiveTradeGateEnabled;
const monitorIdleGate_1 = require("../monitorIdleGate");
/** When true (default), channel-attached signals only execute if MTProto is connected in this process. */
function telegramLiveTradeGateEnabled() {
    const v = String(process.env.WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES ?? 'true').toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'no';
}
exports.PARSED_STATUSES = new Set(['parsed']);
/**
 * Long-lived cache TTLs (24h). Symbol-cache keepalive refreshes entries every
 * SYMBOL_CACHE_KEEPALIVE_MS so we never serve content older than that even if
 * the broker quietly changes contract specs.
 */
exports.SYMBOL_CACHE_TTL_MS = 24 * 60 * 60000;
exports.SYMBOL_LIST_TTL_MS = 24 * 60 * 60000;
exports.SYMBOL_CACHE_STALE_MS = Math.max(30000, Math.min(exports.SYMBOL_CACHE_TTL_MS, Number(process.env.SYMBOL_CACHE_STALE_MS ?? 5 * 60000)));
exports.SYMBOL_CACHE_KEEPALIVE_MS = Math.max(30000, Math.min(exports.SYMBOL_CACHE_TTL_MS, Number(process.env.SYMBOL_CACHE_KEEPALIVE_MS ?? 5 * 60000)));
exports.BROKER_SESSION_HEARTBEAT_MS = Math.max(10000, Math.min(120000, Number(process.env.BROKER_SESSION_HEARTBEAT_MS ?? 30000)));
exports.SESSION_PING_MIN_INTERVAL_MS = Math.max(10000, Math.min(120000, Number(process.env.BROKER_SESSION_PING_MIN_INTERVAL_MS ?? 25000)));
exports.EXECUTOR_PARSED_SWEEP_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('EXECUTOR_PARSED_SWEEP_MS', 1000);
exports.EXECUTOR_SWEEP_IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('EXECUTOR_SWEEP_IDLE_MS', 15000);
exports.EXECUTOR_REPLAY_MAX_AGE_MS = Math.max(60000, Math.min(30 * 60000, Number(process.env.EXECUTOR_REPLAY_MAX_AGE_MS ?? 5 * 60000)));
exports.EXECUTOR_MAX_CONCURRENT_SIGNALS = Math.max(1, Math.min(16, Number(process.env.EXECUTOR_MAX_CONCURRENT_SIGNALS ?? 4)));
exports.EXECUTION_LOG_ACTIONS_HANDLED = [
    'order_send',
    'virtual_pending_inserted',
    'merge_modify_summary',
    'mgmt_close_worse_entries',
];
