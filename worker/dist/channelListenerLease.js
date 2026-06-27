"use strict";
/**
 * Channel reader election via channel_listener_leases (one elected subscriber session).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isChannelLeaseRowLive = isChannelLeaseRowLive;
exports.acquireChannelListenerLease = acquireChannelListenerLease;
exports.renewChannelListenerLease = renewChannelListenerLease;
exports.releaseChannelListenerLease = releaseChannelListenerLease;
exports.fetchChannelLeaseReader = fetchChannelLeaseReader;
exports.isElectedChannelReader = isElectedChannelReader;
exports.electReaderCandidate = electReaderCandidate;
exports.ensureChannelReaderElected = ensureChannelReaderElected;
exports.listActiveChannelLeases = listActiveChannelLeases;
const workerConfig_1 = require("./workerConfig");
const channelListenerConfig_1 = require("./channelListenerConfig");
const leaseGateCache = new Map();
function cacheTtlMs() {
    return Math.max(2000, Math.min(30000, Number(process.env.CHANNEL_LEASE_GATE_CACHE_MS ?? 8000)));
}
function expiresAtIso() {
    return new Date(Date.now() + channelListenerConfig_1.channelListenerConfig.leaseTtlMs).toISOString();
}
function isChannelLeaseRowLive(row, nowMs = Date.now()) {
    if (!row)
        return false;
    return new Date(row.expires_at).getTime() > nowMs;
}
async function acquireChannelListenerLease(supabase, signalChannelId, readerUserId) {
    const workerId = (0, workerConfig_1.channelListenerWorkerId)();
    const expiresAt = expiresAtIso();
    const { data: acquired, error } = await supabase.rpc('acquire_channel_listener_lease', {
        p_signal_channel_id: signalChannelId,
        p_reader_user_id: readerUserId,
        p_worker_id: workerId,
        p_role: workerConfig_1.workerConfig.role === 'channel_listener' ? 'channel_listener' : 'listener',
        p_shard_id: workerConfig_1.workerConfig.shardId,
        p_shard_count: workerConfig_1.workerConfig.shardCount,
        p_expires_at: expiresAt,
    });
    if (error) {
        return acquireChannelListenerLeaseLegacy(supabase, signalChannelId, readerUserId);
    }
    if (acquired === true) {
        leaseGateCache.set(signalChannelId, { readerUserId, expiresAt: Date.now() + cacheTtlMs() });
        return { ok: true };
    }
    const { data: existing } = await supabase
        .from('channel_listener_leases')
        .select('reader_user_id, worker_id, expires_at')
        .eq('signal_channel_id', signalChannelId)
        .maybeSingle();
    const held = existing?.worker_id;
    const exp = existing?.expires_at;
    return {
        ok: false,
        reason: held && exp ? `channel lease held by ${held} until ${exp}` : 'channel lease acquire rejected',
    };
}
async function acquireChannelListenerLeaseLegacy(supabase, signalChannelId, readerUserId) {
    const workerId = (0, workerConfig_1.channelListenerWorkerId)();
    const now = new Date().toISOString();
    const { data: existing } = await supabase
        .from('channel_listener_leases')
        .select('worker_id, expires_at, reader_user_id')
        .eq('signal_channel_id', signalChannelId)
        .maybeSingle();
    if (existing) {
        const exp = new Date(existing.expires_at).getTime();
        const held = existing.worker_id;
        if (exp > Date.now() && held !== workerId) {
            return { ok: false, reason: `channel lease held by ${held} until ${existing.expires_at}` };
        }
    }
    const { error } = await supabase.from('channel_listener_leases').upsert({
        signal_channel_id: signalChannelId,
        reader_user_id: readerUserId,
        worker_id: workerId,
        role: workerConfig_1.workerConfig.role === 'channel_listener' ? 'channel_listener' : 'listener',
        shard_id: workerConfig_1.workerConfig.shardId,
        shard_count: workerConfig_1.workerConfig.shardCount,
        expires_at: expiresAtIso(),
        updated_at: now,
    }, { onConflict: 'signal_channel_id' });
    if (error)
        return { ok: false, reason: error.message };
    leaseGateCache.set(signalChannelId, { readerUserId, expiresAt: Date.now() + cacheTtlMs() });
    return { ok: true };
}
async function renewChannelListenerLease(supabase, signalChannelId, readerUserId) {
    const result = await acquireChannelListenerLease(supabase, signalChannelId, readerUserId);
    return result.ok;
}
async function releaseChannelListenerLease(supabase, signalChannelId) {
    const workerId = (0, workerConfig_1.channelListenerWorkerId)();
    await supabase
        .from('channel_listener_leases')
        .delete()
        .eq('signal_channel_id', signalChannelId)
        .eq('worker_id', workerId);
    leaseGateCache.delete(signalChannelId);
}
async function fetchChannelLeaseReader(supabase, signalChannelId) {
    const cached = leaseGateCache.get(signalChannelId);
    if (cached && cached.expiresAt > Date.now())
        return cached.readerUserId;
    const { data } = await supabase
        .from('channel_listener_leases')
        .select('reader_user_id, expires_at')
        .eq('signal_channel_id', signalChannelId)
        .maybeSingle();
    if (!isChannelLeaseRowLive(data)) {
        leaseGateCache.set(signalChannelId, { readerUserId: null, expiresAt: Date.now() + cacheTtlMs() });
        return null;
    }
    const readerUserId = data.reader_user_id;
    leaseGateCache.set(signalChannelId, { readerUserId, expiresAt: Date.now() + cacheTtlMs() });
    return readerUserId;
}
/** True when this user is the elected MTProto reader for the signal_channel. */
async function isElectedChannelReader(supabase, signalChannelId, userId) {
    const reader = await fetchChannelLeaseReader(supabase, signalChannelId);
    return reader === userId;
}
/** Pick a subscriber to elect as reader (lowest user_id for deterministic failover). */
async function electReaderCandidate(supabase, signalChannelId) {
    const { data } = await supabase
        .from('telegram_channels')
        .select('user_id')
        .eq('signal_channel_id', signalChannelId)
        .eq('is_active', true)
        .order('user_id', { ascending: true })
        .limit(1);
    return data?.[0]?.user_id ?? null;
}
async function ensureChannelReaderElected(supabase, signalChannelId) {
    const existing = await fetchChannelLeaseReader(supabase, signalChannelId);
    if (existing)
        return { readerUserId: existing, elected: false };
    const candidate = await electReaderCandidate(supabase, signalChannelId);
    if (!candidate)
        return { readerUserId: null, elected: false };
    const result = await acquireChannelListenerLease(supabase, signalChannelId, candidate);
    if (!result.ok) {
        const reader = await fetchChannelLeaseReader(supabase, signalChannelId);
        return { readerUserId: reader, elected: false };
    }
    return { readerUserId: candidate, elected: true };
}
async function listActiveChannelLeases(supabase) {
    const { data } = await supabase
        .from('channel_listener_leases')
        .select('signal_channel_id, reader_user_id, worker_id, role, shard_id, shard_count, expires_at')
        .gt('expires_at', new Date().toISOString());
    return (data ?? []);
}
