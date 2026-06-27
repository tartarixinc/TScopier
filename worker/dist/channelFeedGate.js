"use strict";
/**
 * Gate: is the canonical channel feed live for a subscriber?
 * When true in primary mode, passive subscribers skip redundant poll/reconcile.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isChannelFeedLive = isChannelFeedLive;
exports.isChannelFeedLiveForSubscriber = isChannelFeedLiveForSubscriber;
exports.loadPassiveSignalChannelIds = loadPassiveSignalChannelIds;
exports.invalidateChannelFeedCache = invalidateChannelFeedCache;
const channelListenerConfig_1 = require("./channelListenerConfig");
const channelListenerLease_1 = require("./channelListenerLease");
const feedLiveCache = new Map();
function cacheTtlMs() {
    return Math.max(2000, Math.min(30000, Number(process.env.CHANNEL_FEED_GATE_CACHE_MS ?? 8000)));
}
async function fetchCanonicalFeedHealthy(supabase, signalChannelId) {
    const meta = await (0, channelListenerConfig_1.loadSignalChannelMeta)(supabase, signalChannelId);
    if (!meta)
        return false;
    if (!(0, channelListenerConfig_1.isSignalChannelEnrolled)(signalChannelId, meta.telegram_chat_id, meta.subscriber_count)) {
        return false;
    }
    const reader = await (0, channelListenerLease_1.fetchChannelLeaseReader)(supabase, signalChannelId);
    if (!reader)
        return false;
    if (meta.last_live_at) {
        const ageMs = Date.now() - new Date(meta.last_live_at).getTime();
        if (ageMs > channelListenerConfig_1.channelListenerConfig.feedStaleMs)
            return false;
    }
    const { data: lease } = await supabase
        .from('channel_listener_leases')
        .select('expires_at')
        .eq('signal_channel_id', signalChannelId)
        .maybeSingle();
    return (0, channelListenerLease_1.isChannelLeaseRowLive)(lease);
}
async function isChannelFeedLive(supabase, signalChannelId) {
    if (!(0, channelListenerConfig_1.channelListenerModeEnabled)())
        return false;
    const cached = feedLiveCache.get(signalChannelId);
    if (cached && cached.expiresAt > Date.now())
        return cached.live;
    const live = await fetchCanonicalFeedHealthy(supabase, signalChannelId);
    feedLiveCache.set(signalChannelId, { live, expiresAt: Date.now() + cacheTtlMs() });
    return live;
}
/** True when subscriber should rely on canonical feed (skip per-user poll/reconcile). */
async function isChannelFeedLiveForSubscriber(supabase, userId, signalChannelId) {
    if (!(0, channelListenerConfig_1.channelListenerPrimaryMode)())
        return false;
    const reader = await (0, channelListenerLease_1.fetchChannelLeaseReader)(supabase, signalChannelId);
    if (reader === userId)
        return false;
    return isChannelFeedLive(supabase, signalChannelId);
}
async function loadPassiveSignalChannelIds(supabase, userId) {
    const passive = new Set();
    if (!(0, channelListenerConfig_1.channelListenerPrimaryMode)())
        return passive;
    const { data: rows } = await supabase
        .from('telegram_channels')
        .select('signal_channel_id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .not('signal_channel_id', 'is', null);
    for (const row of rows ?? []) {
        const scId = row.signal_channel_id;
        if (!scId)
            continue;
        if (await isChannelFeedLiveForSubscriber(supabase, userId, scId)) {
            passive.add(scId);
        }
    }
    return passive;
}
function invalidateChannelFeedCache(signalChannelId) {
    if (signalChannelId)
        feedLiveCache.delete(signalChannelId);
    else
        feedLiveCache.clear();
}
