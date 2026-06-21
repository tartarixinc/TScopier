"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withDistributedMtServerConnectLock = withDistributedMtServerConnectLock;
const mtServerSessionLock_1 = require("./mtServerSessionLock");
const LOCK_WAIT_MS = Math.max(5000, Number(process.env.MT_SERVER_CONNECT_LOCK_WAIT_MS ?? 90000) || 90000);
const LOCK_POLL_MS = Math.max(200, Number(process.env.MT_SERVER_CONNECT_LOCK_POLL_MS ?? 500) || 500);
const LOCK_TTL_SEC = Math.max(30, Number(process.env.MT_SERVER_CONNECT_LOCK_TTL_SEC ?? 120) || 120);
function holderId() {
    return `worker:${process.env.WORKER_INSTANCE_ID ?? process.pid}`;
}
async function tryAcquireDistributedLock(supabase, lockKey) {
    const { data, error } = await supabase.rpc('try_acquire_mt_server_connect_lock', {
        p_lock_key: lockKey,
        p_holder: holderId(),
        p_ttl_seconds: LOCK_TTL_SEC,
    });
    if (error) {
        console.warn(`[mtServerConnectLock] acquire failed key=${lockKey}: ${error.message}`);
        return true;
    }
    return Boolean(data);
}
async function releaseDistributedLock(supabase, lockKey) {
    const { error } = await supabase.rpc('release_mt_server_connect_lock', {
        p_lock_key: lockKey,
        p_holder: holderId(),
    });
    if (error) {
        console.warn(`[mtServerConnectLock] release failed key=${lockKey}: ${error.message}`);
    }
}
async function waitForDistributedLock(supabase, lockKey) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
        if (await tryAcquireDistributedLock(supabase, lockKey))
            return true;
        await new Promise(r => setTimeout(r, LOCK_POLL_MS));
    }
    console.warn(`[mtServerConnectLock] timed out waiting key=${lockKey}`);
    return false;
}
/**
 * In-process + Postgres lock for ConnectEx. Falls back to in-process only when RPC missing.
 */
async function withDistributedMtServerConnectLock(supabase, platform, server, fn) {
    const lockKey = (0, mtServerSessionLock_1.mtServerLockKey)(platform, server);
    return (0, mtServerSessionLock_1.withMtServerSessionLock)(platform, server, async () => {
        const acquired = await waitForDistributedLock(supabase, lockKey);
        if (!acquired) {
            throw new Error(`Timed out waiting for MT server connect lock (${lockKey})`);
        }
        try {
            return await fn();
        }
        finally {
            await releaseDistributedLock(supabase, lockKey);
        }
    });
}
