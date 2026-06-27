"use strict";
/**
 * Channel reader registry — enrollment, election, and reader assignment per signal_channel.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listEnrolledSignalChannels = listEnrolledSignalChannels;
exports.signalChannelBelongsToShard = signalChannelBelongsToShard;
exports.syncChannelReaders = syncChannelReaders;
exports.renewChannelLeasesForReader = renewChannelLeasesForReader;
exports.failoverChannelReader = failoverChannelReader;
const channelListenerConfig_1 = require("./channelListenerConfig");
const channelListenerLease_1 = require("./channelListenerLease");
const workerConfig_1 = require("./workerConfig");
async function listEnrolledSignalChannels(supabase) {
    if (!(0, channelListenerConfig_1.channelListenerModeEnabled)())
        return [];
    const { data } = await supabase
        .from('signal_channels')
        .select('id, telegram_chat_id, subscriber_count')
        .gt('subscriber_count', 0)
        .order('subscriber_count', { ascending: false });
    const out = [];
    for (const row of data ?? []) {
        const r = row;
        if (!(0, channelListenerConfig_1.isSignalChannelEnrolled)(r.id, r.telegram_chat_id, r.subscriber_count))
            continue;
        if (!signalChannelBelongsToShard(r.id))
            continue;
        const readerUserId = await (0, channelListenerLease_1.fetchChannelLeaseReader)(supabase, r.id);
        out.push({
            signalChannelId: r.id,
            telegramChatId: r.telegram_chat_id,
            subscriberCount: r.subscriber_count,
            readerUserId,
        });
    }
    return out;
}
function signalChannelBelongsToShard(signalChannelId) {
    if (workerConfig_1.workerConfig.shardCount <= 1)
        return true;
    return (0, workerConfig_1.shardForSignalChannelId)(signalChannelId, workerConfig_1.workerConfig.shardCount) === workerConfig_1.workerConfig.shardId;
}
/** Ensure every enrolled channel on this shard has an elected reader. */
async function syncChannelReaders(supabase) {
    const channels = await listEnrolledSignalChannels(supabase);
    let elected = 0;
    for (const ch of channels) {
        if (ch.readerUserId)
            continue;
        const result = await (0, channelListenerLease_1.ensureChannelReaderElected)(supabase, ch.signalChannelId);
        if (result.elected) {
            elected++;
            (0, channelListenerConfig_1.recordSignalChannelMetric)(ch.signalChannelId, 'channel_reader_elected');
            console.log(`[channelReaderRegistry] elected reader user=${result.readerUserId} signalChannel=${ch.signalChannelId}`);
        }
    }
    return { elected, total: channels.length };
}
/** Renew leases for channels where this worker holds the reader session. */
async function renewChannelLeasesForReader(supabase, readerUserId) {
    const { data } = await supabase
        .from('channel_listener_leases')
        .select('signal_channel_id')
        .eq('reader_user_id', readerUserId)
        .gt('expires_at', new Date(Date.now() - 5000).toISOString());
    let renewed = 0;
    for (const row of data ?? []) {
        const scId = row.signal_channel_id;
        if (!signalChannelBelongsToShard(scId))
            continue;
        const ok = await (0, channelListenerLease_1.renewChannelListenerLease)(supabase, scId, readerUserId);
        if (ok)
            renewed++;
    }
    return renewed;
}
/** Failover: re-elect when reader subscription deactivated. */
async function failoverChannelReader(supabase, signalChannelId) {
    const current = await (0, channelListenerLease_1.fetchChannelLeaseReader)(supabase, signalChannelId);
    if (current) {
        const { data: stillActive } = await supabase
            .from('telegram_channels')
            .select('id')
            .eq('user_id', current)
            .eq('signal_channel_id', signalChannelId)
            .eq('is_active', true)
            .maybeSingle();
        if (stillActive)
            return current;
    }
    const candidate = await (0, channelListenerLease_1.electReaderCandidate)(supabase, signalChannelId);
    if (!candidate)
        return null;
    const result = await (0, channelListenerLease_1.ensureChannelReaderElected)(supabase, signalChannelId);
    return result.readerUserId;
}
