"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquireSessionLease = acquireSessionLease;
exports.ensureSessionLeaseFresh = ensureSessionLeaseFresh;
exports.renewSessionLease = renewSessionLease;
exports.releaseSessionLease = releaseSessionLease;
exports.isTelegramListenerLiveForUser = isTelegramListenerLiveForUser;
exports.listActiveLeases = listActiveLeases;
const workerConfig_1 = require("./workerConfig");
const LEASE_TTL_MS = Math.max(15000, Math.min(120000, Number(process.env.WORKER_SESSION_LEASE_TTL_MS ?? 45000)));
const LEASE_GATE_CACHE_MS = Math.max(2000, Math.min(60000, Number(process.env.WORKER_LEASE_GATE_CACHE_MS ?? 8000)));
const listenerLiveCache = new Map();
function cachedListenerLive(userId) {
    const hit = listenerLiveCache.get(userId);
    if (!hit)
        return null;
    if (hit.expiresAt <= Date.now()) {
        listenerLiveCache.delete(userId);
        return null;
    }
    return hit.live;
}
function setCachedListenerLive(userId, live) {
    listenerLiveCache.set(userId, { live, expiresAt: Date.now() + LEASE_GATE_CACHE_MS });
}
function expiresAtIso() {
    return new Date(Date.now() + LEASE_TTL_MS).toISOString();
}
/**
 * Claim listener ownership for user_id. Fails if another worker holds a non-expired lease.
 * Uses Postgres advisory lock + conditional update (acquire_worker_session_lease RPC).
 */
async function acquireSessionLease(supabase, userId) {
    const workerId = (0, workerConfig_1.listenerWorkerId)();
    const expiresAt = expiresAtIso();
    const { data: acquired, error } = await supabase.rpc('acquire_worker_session_lease', {
        p_user_id: userId,
        p_worker_id: workerId,
        p_role: (0, workerConfig_1.leaseRoleLabel)(),
        p_shard_id: workerConfig_1.workerConfig.shardId,
        p_shard_count: workerConfig_1.workerConfig.shardCount,
        p_expires_at: expiresAt,
    });
    if (error) {
        // Fallback for environments without migration applied yet.
        console.warn('[sessionLease] RPC acquire failed, using legacy upsert:', error.message);
        return acquireSessionLeaseLegacy(supabase, userId);
    }
    if (acquired === true)
        return { ok: true };
    const { data: existing } = await supabase
        .from('worker_session_leases')
        .select('worker_id, expires_at')
        .eq('user_id', userId)
        .maybeSingle();
    const held = existing?.worker_id;
    const exp = existing?.expires_at;
    return {
        ok: false,
        reason: held && exp
            ? `lease held by ${held} until ${exp}`
            : 'lease acquire rejected',
    };
}
/** Legacy upsert path when RPC migration is not yet applied. */
async function acquireSessionLeaseLegacy(supabase, userId) {
    const workerId = (0, workerConfig_1.listenerWorkerId)();
    const now = new Date().toISOString();
    const { data: existing } = await supabase
        .from('worker_session_leases')
        .select('worker_id, expires_at')
        .eq('user_id', userId)
        .maybeSingle();
    if (existing) {
        const exp = new Date(existing.expires_at).getTime();
        const held = existing.worker_id;
        if (exp > Date.now() && held !== workerId) {
            return { ok: false, reason: `lease held by ${held} until ${existing.expires_at}` };
        }
    }
    const { error } = await supabase.from('worker_session_leases').upsert({
        user_id: userId,
        worker_id: workerId,
        role: (0, workerConfig_1.leaseRoleLabel)(),
        shard_id: workerConfig_1.workerConfig.shardId,
        shard_count: workerConfig_1.workerConfig.shardCount,
        expires_at: expiresAtIso(),
        updated_at: now,
    }, { onConflict: 'user_id' });
    if (error)
        return { ok: false, reason: error.message };
    return { ok: true };
}
/**
 * Refresh listener lease via acquire RPC (extends TTL for this worker or reclaims expired rows).
 * Unlike renewSessionLease, survives pod restarts where worker_id changed while MTProto stayed up.
 */
async function ensureSessionLeaseFresh(supabase, userId) {
    const wasLive = await fetchTelegramListenerLiveForUser(supabase, userId);
    const result = await acquireSessionLease(supabase, userId);
    if (!result.ok) {
        setCachedListenerLive(userId, false);
        return result;
    }
    setCachedListenerLive(userId, true);
    return { ok: true, recovered: !wasLive };
}
/** @deprecated Prefer ensureSessionLeaseFresh — direct UPDATE misses expired or foreign worker_id rows. */
async function renewSessionLease(supabase, userId) {
    await ensureSessionLeaseFresh(supabase, userId);
}
async function releaseSessionLease(supabase, userId) {
    const workerId = (0, workerConfig_1.listenerWorkerId)();
    await supabase
        .from('worker_session_leases')
        .delete()
        .eq('user_id', userId)
        .eq('worker_id', workerId);
}
/** Trade workers: true when a listener shard holds a fresh lease (Telegram path is live). */
async function isTelegramListenerLiveForUser(supabase, userId) {
    const cached = cachedListenerLive(userId);
    if (cached != null)
        return cached;
    const live = await fetchTelegramListenerLiveForUser(supabase, userId);
    setCachedListenerLive(userId, live);
    return live;
}
async function fetchTelegramListenerLiveForUser(supabase, userId) {
    const { data } = await supabase
        .from('worker_session_leases')
        .select('expires_at, role')
        .eq('user_id', userId)
        .maybeSingle();
    if (!data)
        return false;
    const role = String(data.role ?? '');
    if (role !== 'listener' && role !== 'all')
        return false;
    return new Date(data.expires_at).getTime() > Date.now();
}
async function listActiveLeases(supabase) {
    const { data } = await supabase
        .from('worker_session_leases')
        .select('*')
        .gt('expires_at', new Date().toISOString());
    return (data ?? []);
}
