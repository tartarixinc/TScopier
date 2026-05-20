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
 * Channels copy only when explicitly listed in `signal_channel_ids`.
 */
function channelMatchesBrokerSignal(broker, channelId) {
    const ids = normalizeSignalChannelIds(broker.signal_channel_ids);
    if (!ids.length || !channelId)
        return false;
    return ids.includes(channelId);
}
