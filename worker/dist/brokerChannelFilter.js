"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSignalChannelIds = normalizeSignalChannelIds;
exports.channelMatchesBrokerSignal = channelMatchesBrokerSignal;
function normalizeSignalChannelIds(raw) {
    if (!raw?.length)
        return [];
    return raw.map(String).filter(Boolean);
}
/**
 * True when this broker should copy signals from `channelId`.
 * Whitelist applies only when `enforce_signal_channel_filter` is true (saved from
 * Configure Trading). Stale `signal_channel_ids` with enforce off are ignored.
 */
function channelMatchesBrokerSignal(broker, channelId) {
    if (broker.enforce_signal_channel_filter !== true)
        return true;
    const ids = normalizeSignalChannelIds(broker.signal_channel_ids);
    if (!ids.length)
        return true;
    if (!channelId)
        return false;
    return ids.includes(channelId);
}
