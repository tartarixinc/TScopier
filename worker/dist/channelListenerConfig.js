"use strict";
/**
 * Channel-scoped listener feature flags and enrollment helpers.
 *
 * CHANNEL_LISTENER_MODE:
 *   off      — per-user ingest only (default, rollback)
 *   shadow   — elected reader writes canonical store; per-user ingest remains primary
 *   primary  — canonical feed drives projection; passive subscribers skip redundant polls
 *
 * CHANNEL_LISTENER_ALLOWLIST — comma-separated signal_channels.id or telegram_chat_id values.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelListenerConfig = void 0;
exports.channelListenerModeEnabled = channelListenerModeEnabled;
exports.channelListenerPrimaryMode = channelListenerPrimaryMode;
exports.channelListenerShadowMode = channelListenerShadowMode;
exports.isSignalChannelEnrolled = isSignalChannelEnrolled;
exports.recordSignalChannelMetric = recordSignalChannelMetric;
exports.loadSignalChannelMeta = loadSignalChannelMeta;
exports.countActiveSubscribers = countActiveSubscribers;
const workerMetrics_1 = require("./workerMetrics");
const telegramChatId_1 = require("./telegramChatId");
const AUTO_ENROLL_MIN_SUBSCRIBERS = Math.max(1, Math.floor(Number(process.env.CHANNEL_LISTENER_AUTO_ENROLL_MIN ?? 3)));
function parseMode(raw) {
    const v = String(raw ?? 'off').toLowerCase().trim();
    if (v === 'shadow' || v === 'primary')
        return v;
    return 'off';
}
function parseAllowlist(raw) {
    const out = new Set();
    for (const part of String(raw ?? '').split(',')) {
        const t = part.trim();
        if (t)
            out.add(t);
    }
    return out;
}
const globalMode = parseMode(process.env.CHANNEL_LISTENER_MODE);
const allowlist = parseAllowlist(process.env.CHANNEL_LISTENER_ALLOWLIST);
function runtimeMode() {
    return parseMode(process.env.CHANNEL_LISTENER_MODE ?? globalMode);
}
function runtimeAllowlist() {
    const raw = process.env.CHANNEL_LISTENER_ALLOWLIST;
    if (raw === undefined || raw === '')
        return allowlist;
    return parseAllowlist(raw);
}
exports.channelListenerConfig = {
    get mode() { return runtimeMode(); },
    get allowlist() { return runtimeAllowlist(); },
    autoEnrollMinSubscribers: AUTO_ENROLL_MIN_SUBSCRIBERS,
    leaseTtlMs: Math.max(15000, Math.min(120000, Number(process.env.CHANNEL_LISTENER_LEASE_TTL_MS ?? 45000))),
    feedStaleMs: Math.max(30000, Math.min(600000, Number(process.env.CHANNEL_LISTENER_FEED_STALE_MS ?? 120000))),
    inheritBackfillHours: Math.max(1, Math.min(168, Number(process.env.CHANNEL_INHERIT_BACKFILL_HOURS ?? 24))),
};
function channelListenerModeEnabled() {
    return runtimeMode() !== 'off';
}
function channelListenerPrimaryMode() {
    return runtimeMode() === 'primary';
}
function channelListenerShadowMode() {
    return runtimeMode() === 'shadow';
}
function isSignalChannelEnrolled(signalChannelId, telegramChatId, subscriberCount) {
    const mode = runtimeMode();
    if (mode === 'off')
        return false;
    const list = runtimeAllowlist();
    if (list.size > 0) {
        if (list.has(signalChannelId))
            return true;
        if (telegramChatId) {
            const canonical = (0, telegramChatId_1.normalizeTelegramChatId)(telegramChatId);
            if (list.has(canonical) || list.has(telegramChatId))
                return true;
        }
        return false;
    }
    if (subscriberCount != null && subscriberCount >= exports.channelListenerConfig.autoEnrollMinSubscribers) {
        return true;
    }
    return false;
}
function recordSignalChannelMetric(signalChannelId, name, delta = 1) {
    (0, workerMetrics_1.incMetric)(name, delta);
    (0, workerMetrics_1.incMetric)(`${name}:${signalChannelId.slice(0, 8)}`, delta);
}
async function loadSignalChannelMeta(supabase, signalChannelId) {
    const { data } = await supabase
        .from('signal_channels')
        .select('id, telegram_chat_id, subscriber_count, last_live_at')
        .eq('id', signalChannelId)
        .maybeSingle();
    return data;
}
async function countActiveSubscribers(supabase, signalChannelId) {
    const { count } = await supabase
        .from('telegram_channels')
        .select('id', { count: 'exact', head: true })
        .eq('signal_channel_id', signalChannelId)
        .eq('is_active', true);
    return count ?? 0;
}
