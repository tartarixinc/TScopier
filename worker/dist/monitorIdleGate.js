"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitorActiveIntervalMs = monitorActiveIntervalMs;
exports.monitorIdleIntervalMs = monitorIdleIntervalMs;
exports.startMonitorLoop = startMonitorLoop;
exports.shardUserIds = shardUserIds;
exports.tableHasRows = tableHasRows;
exports.applyShardUserFilter = applyShardUserFilter;
exports.invalidateShardUserCache = invalidateShardUserCache;
exports.hasWorkOnShard = hasWorkOnShard;
exports.applyShardToQuery = applyShardToQuery;
const workerConfig_1 = require("./workerConfig");
/** Active tick interval when work exists (default 1500ms). */
function monitorActiveIntervalMs(envKey, defaultMs) {
    const raw = Number(process.env[envKey]);
    if (Number.isFinite(raw) && raw >= 500)
        return Math.min(raw, 60000);
    return defaultMs;
}
/** Idle backoff when no work exists (default 60000ms). */
function monitorIdleIntervalMs(envKey, defaultMs = 60000) {
    const raw = Number(process.env[envKey]);
    if (Number.isFinite(raw) && raw >= 5000)
        return Math.min(raw, 300000);
    return defaultMs;
}
/**
 * Schedules monitor ticks with idle backoff: cheap hasWork probe first,
 * full tick only when work exists, longer sleep when idle.
 */
function startMonitorLoop(opts) {
    let timer = null;
    let stopped = false;
    let ticking = false;
    const schedule = (delayMs) => {
        if (stopped)
            return;
        timer = setTimeout(() => { void runCycle(); }, delayMs);
        timer.unref?.();
    };
    const runCycle = async () => {
        if (stopped || ticking) {
            schedule(opts.activeIntervalMs);
            return;
        }
        ticking = true;
        try {
            const work = await opts.hasWork(opts.supabase);
            if (!work) {
                schedule(opts.idleIntervalMs);
                return;
            }
            await opts.tick(opts.supabase);
            schedule(opts.activeIntervalMs);
        }
        catch (err) {
            console.error(`[${opts.name}] tick failed:`, err instanceof Error ? err.message : String(err));
            schedule(opts.activeIntervalMs);
        }
        finally {
            ticking = false;
        }
    };
    schedule(0);
    return {
        stop() {
            stopped = true;
            if (timer)
                clearTimeout(timer);
            timer = null;
        },
        poke() {
            if (stopped)
                return;
            if (timer)
                clearTimeout(timer);
            schedule(0);
        },
    };
}
const SHARD_USERS_TTL_MS = 5 * 60000;
let cachedShardUserIds = null;
let cachedShardUserIdsAt = 0;
/** Active broker user ids on this worker shard (null = no shard filter). */
async function shardUserIds(supabase) {
    if (workerConfig_1.workerConfig.shardCount <= 1)
        return null;
    const now = Date.now();
    if (cachedShardUserIds && now - cachedShardUserIdsAt < SHARD_USERS_TTL_MS) {
        return cachedShardUserIds;
    }
    const { data, error } = await supabase
        .from('broker_accounts')
        .select('user_id')
        .eq('is_active', true);
    if (error) {
        console.warn('[monitorIdleGate] shardUserIds load failed:', error.message);
        return cachedShardUserIds;
    }
    const ids = [...new Set((data ?? [])
            .map(r => String(r.user_id ?? ''))
            .filter(uid => uid && (0, workerConfig_1.userBelongsToShard)(uid)))];
    cachedShardUserIds = ids;
    cachedShardUserIdsAt = now;
    return ids;
}
/** Cheap existence check via HEAD count. */
async function tableHasRows(supabase, table, build) {
    let q = supabase.from(table).select('id', { count: 'exact', head: true });
    q = build(q);
    const { count, error } = await q;
    if (error) {
        console.warn(`[monitorIdleGate] tableHasRows ${table}:`, error.message);
        return true;
    }
    return (count ?? 0) > 0;
}
/** Apply shard user_id filter when sharding is enabled. */
function applyShardUserFilter(q, userIds) {
    if (userIds === null)
        return q;
    if (userIds.length === 0)
        return null;
    return q.in('user_id', userIds);
}
function invalidateShardUserCache() {
    cachedShardUserIds = null;
    cachedShardUserIdsAt = 0;
}
/** Existence check with optional shard user_id filter. */
async function hasWorkOnShard(supabase, table, build) {
    const uids = await shardUserIds(supabase);
    if (uids !== null && uids.length === 0)
        return false;
    let q = supabase.from(table).select('id', { count: 'exact', head: true });
    q = build(q);
    if (uids !== null)
        q = q.in('user_id', uids);
    const { count, error } = await q;
    if (error) {
        console.warn(`[monitorIdleGate] hasWorkOnShard ${table}:`, error.message);
        return true;
    }
    return (count ?? 0) > 0;
}
/** Apply shard filter to a select query; returns null when shard has no users. */
async function applyShardToQuery(supabase, q) {
    const uids = await shardUserIds(supabase);
    if (uids === null)
        return q;
    if (uids.length === 0)
        return null;
    return q.in('user_id', uids);
}
