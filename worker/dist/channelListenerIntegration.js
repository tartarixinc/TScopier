"use strict";
/**
 * Integration hooks for UserListener ↔ channel-scoped listener pipeline.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshPassiveSignalChannels = refreshPassiveSignalChannels;
exports.resolveSignalChannelIdForRow = resolveSignalChannelIdForRow;
exports.shouldSkipPassiveChannelIngest = shouldSkipPassiveChannelIngest;
exports.syncUserChannelReaderLeases = syncUserChannelReaderLeases;
exports.handlePostParseChannelIngest = handlePostParseChannelIngest;
exports.isChannelRowPassive = isChannelRowPassive;
const channelListenerConfig_1 = require("./channelListenerConfig");
const channelListenerLease_1 = require("./channelListenerLease");
const channelCanonicalIngest_1 = require("./channelCanonicalIngest");
const channelFeedGate_1 = require("./channelFeedGate");
const channelReaderRegistry_1 = require("./channelReaderRegistry");
const workerMetrics_1 = require("./workerMetrics");
async function refreshPassiveSignalChannels(supabase, userId) {
    if (!(0, channelListenerConfig_1.channelListenerPrimaryMode)())
        return new Set();
    return (0, channelFeedGate_1.loadPassiveSignalChannelIds)(supabase, userId);
}
async function resolveSignalChannelIdForRow(supabase, row) {
    if (row.signal_channel_id)
        return row.signal_channel_id;
    const { data } = await supabase
        .from('telegram_channels')
        .select('signal_channel_id')
        .eq('id', row.id)
        .maybeSingle();
    return data?.signal_channel_id ?? null;
}
async function shouldSkipPassiveChannelIngest(supabase, userId, signalChannelId, passiveCache) {
    if (!(0, channelListenerConfig_1.channelListenerPrimaryMode)())
        return false;
    if (passiveCache.has(signalChannelId))
        return true;
    const passive = await (0, channelFeedGate_1.loadPassiveSignalChannelIds)(supabase, userId);
    for (const id of passive)
        passiveCache.add(id);
    return passiveCache.has(signalChannelId);
}
/** Try to acquire channel listener leases for enrolled channels this user subscribes to. */
async function syncUserChannelReaderLeases(supabase, userId) {
    if (!(0, channelListenerConfig_1.channelListenerModeEnabled)())
        return 0;
    const { data: subs } = await supabase
        .from('telegram_channels')
        .select('signal_channel_id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .not('signal_channel_id', 'is', null);
    let acquired = 0;
    for (const row of subs ?? []) {
        const scId = row.signal_channel_id;
        if (!scId || !(0, channelReaderRegistry_1.signalChannelBelongsToShard)(scId))
            continue;
        const meta = await (0, channelListenerConfig_1.loadSignalChannelMeta)(supabase, scId);
        if (!meta || !(0, channelListenerConfig_1.isSignalChannelEnrolled)(scId, meta.telegram_chat_id, meta.subscriber_count)) {
            continue;
        }
        const currentReader = await (0, channelListenerLease_1.fetchChannelLeaseReader)(supabase, scId);
        if (currentReader && currentReader !== userId)
            continue;
        const result = await (0, channelListenerLease_1.acquireChannelListenerLease)(supabase, scId, userId);
        if (result.ok) {
            acquired++;
            (0, workerMetrics_1.incMetric)('channel_reader_lease_acquired');
        }
    }
    return acquired;
}
/**
 * After parse on elected reader: write canonical store; in primary mode fan-out via projector.
 * Returns true when per-user ingest/dispatch should be skipped (primary + elected reader).
 */
async function handlePostParseChannelIngest(args) {
    if (!(0, channelListenerConfig_1.channelListenerModeEnabled)()) {
        return { skipPerUserIngest: false, canonicalWritten: false };
    }
    const elected = await (0, channelListenerLease_1.isElectedChannelReader)(args.supabase, args.signalChannelId, args.userId);
    if (!elected)
        return { skipPerUserIngest: false, canonicalWritten: false };
    const { canonical, projected } = await (0, channelCanonicalIngest_1.ingestCanonicalFromReader)(args.supabase, {
        signalChannelId: args.signalChannelId,
        telegramMessageId: args.messageId,
        rawMessage: args.rawMessage,
        replyToMessageId: args.replyToMessageId,
        parseResult: args.parseResult,
        pipelineTs: args.pipelineTs ?? null,
    }, args.dispatch);
    if ((0, channelListenerConfig_1.channelListenerShadowMode)() && canonical) {
        await (0, channelCanonicalIngest_1.compareShadowSignal)(args.supabase, {
            userId: args.userId,
            subscriptionRowId: args.channelRow.id,
            signalChannelId: args.signalChannelId,
            telegramMessageId: args.messageId,
            canonicalParsed: args.parseResult.parsed,
            canonicalStatus: args.parseResult.status,
            userParsed: args.parseResult.parsed,
            userStatus: args.parseResult.status,
        });
    }
    if ((0, channelListenerConfig_1.channelListenerPrimaryMode)()) {
        (0, workerMetrics_1.incMetric)('channel_primary_reader_ingest');
        if (projected > 0)
            (0, workerMetrics_1.incMetric)('channel_primary_projected', projected);
        return { skipPerUserIngest: true, canonicalWritten: Boolean(canonical) };
    }
    return { skipPerUserIngest: false, canonicalWritten: Boolean(canonical) };
}
function isChannelRowPassive(signalChannelId, passiveCache) {
    if (!signalChannelId || !(0, channelListenerConfig_1.channelListenerPrimaryMode)())
        return false;
    return passiveCache.has(signalChannelId);
}
