"use strict";
/**
 * Listener → trade worker HTTP push (split deploy). Supabase Realtime remains fallback.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTradeWorkerShardUrls = parseTradeWorkerShardUrls;
exports.pushParsedSignalToTradeWorker = pushParsedSignalToTradeWorker;
exports.validateListenerTradeShardConfig = validateListenerTradeShardConfig;
exports.validateListenerQueueConfig = validateListenerQueueConfig;
const tradeSignalActions_1 = require("./tradeSignalActions");
const signalQueueConfig_1 = require("./queue/signalQueueConfig");
const workerConfig_1 = require("./workerConfig");
const PUSH_MAX_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.TRADE_SIGNAL_PUSH_MAX_ATTEMPTS ?? 3)));
const PUSH_RETRY_BASE_MS = Math.max(25, Math.min(500, Number(process.env.TRADE_SIGNAL_PUSH_RETRY_BASE_MS ?? 75)));
const SUPABASE_URL = String(process.env.SUPABASE_URL ?? '').trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
function tradePushEnabled() {
    const v = String(process.env.TRADE_SIGNAL_PUSH_ENABLED ?? 'true').toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'no';
}
function internalToken() {
    return String(process.env.WORKER_INTERNAL_TOKEN ?? '').trim();
}
function parseTradeWorkerShardUrls(raw) {
    if (!raw?.trim())
        return [];
    return raw.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
}
function pickTradeWorkerUrl(action, userId) {
    const shardUrls = parseTradeWorkerShardUrls(process.env.TRADE_WORKER_SHARD_URLS);
    const entryUrl = String(process.env.TRADE_WORKER_URL ?? '').trim().replace(/\/$/, '');
    const mgmtUrl = String(process.env.TRADE_MGMT_WORKER_URL ?? '').trim().replace(/\/$/, '');
    let base;
    if ((0, tradeSignalActions_1.isManagementAction)(action)) {
        base = mgmtUrl || entryUrl || null;
    }
    else {
        base = entryUrl || null;
    }
    if (shardUrls.length > 1 && userId) {
        const shard = (0, workerConfig_1.shardForUserId)(userId, shardUrls.length);
        const sharded = shardUrls[shard];
        if (sharded) {
            if ((0, tradeSignalActions_1.isManagementAction)(action) && mgmtUrl)
                return mgmtUrl;
            return sharded;
        }
    }
    if (shardUrls.length === 1 && userId && !(0, tradeSignalActions_1.isManagementAction)(action)) {
        return shardUrls[0];
    }
    return base;
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function isRetryablePushStatus(status) {
    return status >= 500 || status === 429 || status === 408;
}
function logPushFailed(row, baseUrl, action, reason, attempt) {
    console.warn(JSON.stringify({
        event: 'push_failed',
        user_id: row.user_id,
        signal_id: row.id,
        action,
        url: baseUrl,
        attempt,
        max_attempts: PUSH_MAX_ATTEMPTS,
        reason,
    }));
}
async function logPushAttemptToDb(row, status, payload) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
        return;
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/trade_execution_logs`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                Prefer: 'return=minimal',
            },
            body: JSON.stringify([{
                    user_id: row.user_id,
                    signal_id: row.id,
                    action: 'dispatch_push_attempt',
                    status,
                    request_payload: payload,
                }]),
        });
    }
    catch {
        /* best-effort */
    }
}
async function postDispatchSignal(url, token, signalBody, priority, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('trade-push-timeout'), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-internal-token': token,
            },
            body: JSON.stringify({ signal: signalBody, priority, source: 'listener_push' }),
            signal: controller.signal,
        });
        if (res.ok) {
            return { ok: true, status: res.status, retryable: false, detail: '' };
        }
        const text = await res.text().catch(() => '');
        return {
            ok: false,
            status: res.status,
            retryable: isRetryablePushStatus(res.status),
            detail: text.slice(0, 200),
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 0, retryable: true, detail: msg };
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Fire-and-forget POST to trade worker with short retry on transient failures.
 */
function pushParsedSignalToTradeWorker(row) {
    if (!tradePushEnabled()) {
        console.warn('[tradeSignalPush] disabled (TRADE_SIGNAL_PUSH_ENABLED=false)');
        return;
    }
    const token = internalToken();
    if (!token) {
        console.warn('[tradeSignalPush] missing WORKER_INTERNAL_TOKEN — cannot push to trade worker');
        return;
    }
    const action = (0, tradeSignalActions_1.parsedAction)(row.parsed_data);
    const baseUrl = pickTradeWorkerUrl(action, row.user_id);
    if (!baseUrl) {
        console.warn(`[tradeSignalPush] no trade worker URL for action=${action} user=${row.user_id}`
            + ' — set TRADE_WORKER_URL / TRADE_MGMT_WORKER_URL on listener');
        return;
    }
    const timeoutMs = Math.max(500, Math.min(10000, Number(process.env.TRADE_SIGNAL_PUSH_TIMEOUT_MS ?? 4000)));
    const url = `${baseUrl}/internal/dispatch-signal`;
    const priority = (0, tradeSignalActions_1.dispatchPriorityForAction)(action);
    const signalBody = {
        id: row.id,
        user_id: row.user_id,
        channel_id: row.channel_id,
        parsed_data: row.parsed_data,
        status: row.status,
        parent_signal_id: row.parent_signal_id ?? null,
        is_modification: row.is_modification ?? false,
        telegram_message_id: row.telegram_message_id ?? null,
        reply_to_message_id: row.reply_to_message_id ?? null,
        created_at: row.created_at,
        pipeline_ts: row.pipeline_ts,
    };
    void (async () => {
        await logPushAttemptToDb(row, 'success', {
            run_id: 'latency-v3',
            phase: 'start',
            action,
            base_url: baseUrl,
            timeout_ms: timeoutMs,
            max_attempts: PUSH_MAX_ATTEMPTS,
        });
        for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt++) {
            const attemptStartedAt = Date.now();
            const result = await postDispatchSignal(url, token, signalBody, priority, timeoutMs);
            await logPushAttemptToDb(row, result.ok ? 'success' : 'failed', {
                run_id: 'latency-v3',
                phase: 'attempt',
                action,
                attempt,
                ok: result.ok,
                status_code: result.status,
                retryable: result.retryable,
                elapsed_ms: Date.now() - attemptStartedAt,
                detail: result.detail.slice(0, 120),
            });
            if (result.ok)
                return;
            const reason = result.status > 0
                ? `status=${result.status} ${result.detail}`
                : result.detail;
            if (!result.retryable || attempt >= PUSH_MAX_ATTEMPTS) {
                logPushFailed(row, baseUrl, action, reason, attempt);
                return;
            }
            const backoffMs = PUSH_RETRY_BASE_MS * attempt;
            await sleep(backoffMs);
        }
    })();
}
/**
 * Listener startup check: TRADE_WORKER_SHARD_URLS count must match TRADE_WORKER_SHARD_COUNT.
 * Returns error message or null if valid / not applicable.
 */
function validateListenerTradeShardConfig() {
    const shardUrls = parseTradeWorkerShardUrls(process.env.TRADE_WORKER_SHARD_URLS);
    if (shardUrls.length === 0)
        return null;
    const expectedRaw = process.env.TRADE_WORKER_SHARD_COUNT;
    const expected = expectedRaw != null && expectedRaw !== ''
        ? Math.max(1, Math.floor(Number(expectedRaw)))
        : shardUrls.length;
    if (!Number.isFinite(expected) || expected < 1) {
        return `TRADE_WORKER_SHARD_COUNT must be a positive integer (got ${expectedRaw})`;
    }
    if (shardUrls.length !== expected) {
        return `TRADE_WORKER_SHARD_URLS has ${shardUrls.length} URL(s) but TRADE_WORKER_SHARD_COUNT=${expected}`;
    }
    return null;
}
/**
 * Listener startup check for Redis queue env when queue mode is enabled.
 */
function validateListenerQueueConfig() {
    const cfg = (0, signalQueueConfig_1.signalQueueConfig)();
    if (!cfg.enabled)
        return null;
    if (!(0, signalQueueConfig_1.redisQueueConfigured)()) {
        return 'TRADE_SIGNAL_QUEUE_ENABLED=true but UPSTASH_REDIS_REST_URL/TOKEN (or REDIS_REST_*) are missing';
    }
    if (cfg.shardCount < 1) {
        return 'TRADE_SIGNAL_QUEUE_SHARD_COUNT must be >= 1';
    }
    return null;
}
