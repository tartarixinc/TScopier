"use strict";
/**
 * Fast idempotency guard for queue redelivery (at-least-once safety).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDuplicateQueueDelivery = isDuplicateQueueDelivery;
exports.claimQueueIdempotency = claimQueueIdempotency;
exports.resetIdempotencyCache = resetIdempotencyCache;
const recentKeys = new Map();
const RECENT_TTL_MS = Math.max(60000, Number(process.env.TRADE_SIGNAL_QUEUE_IDEMPOTENCY_TTL_MS ?? 600000));
const RECENT_MAX = Math.max(1000, Number(process.env.TRADE_SIGNAL_QUEUE_IDEMPOTENCY_CACHE_MAX ?? 20000));
function pruneRecent(now) {
    if (recentKeys.size <= RECENT_MAX)
        return;
    for (const [key, expiresAt] of recentKeys) {
        if (expiresAt <= now)
            recentKeys.delete(key);
        if (recentKeys.size <= RECENT_MAX * 0.8)
            break;
    }
}
function markRecent(key) {
    const now = Date.now();
    recentKeys.set(key, now + RECENT_TTL_MS);
    pruneRecent(now);
}
function isRecent(key) {
    const expiresAt = recentKeys.get(key);
    if (!expiresAt)
        return false;
    if (expiresAt <= Date.now()) {
        recentKeys.delete(key);
        return false;
    }
    return true;
}
/** Returns true when this delivery should be skipped as a duplicate. */
async function isDuplicateQueueDelivery(supabase, idempotencyKey) {
    if (isRecent(idempotencyKey))
        return true;
    const { data, error } = await supabase
        .from('signal_queue_idempotency')
        .select('id')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
    if (error) {
        console.warn(`[signalQueue] idempotency lookup failed key=${idempotencyKey}: ${error.message}`);
        return false;
    }
    if (data) {
        markRecent(idempotencyKey);
        return true;
    }
    return false;
}
/** Claim idempotency before execution. Returns false if already claimed. */
async function claimQueueIdempotency(supabase, idempotencyKey, meta) {
    if (isRecent(idempotencyKey))
        return false;
    const { error } = await supabase.from('signal_queue_idempotency').insert({
        idempotency_key: idempotencyKey,
        signal_id: meta.signal_id,
        user_id: meta.user_id,
        lane: meta.lane,
    });
    if (error) {
        if (error.code === '23505') {
            markRecent(idempotencyKey);
            return false;
        }
        console.warn(`[signalQueue] idempotency claim failed key=${idempotencyKey}: ${error.message}`);
        return true;
    }
    markRecent(idempotencyKey);
    return true;
}
/** Test helper */
function resetIdempotencyCache() {
    recentKeys.clear();
}
