"use strict";
/**
 * Canonical ingest (channel_messages + channel_signals) and shadow compare.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeChannelMessage = writeChannelMessage;
exports.writeChannelSignal = writeChannelSignal;
exports.compareShadowSignal = compareShadowSignal;
exports.ingestCanonicalFromReader = ingestCanonicalFromReader;
const node_crypto_1 = require("node:crypto");
const channelListenerConfig_1 = require("./channelListenerConfig");
const channelSignalProjector_1 = require("./channelSignalProjector");
const workerMetrics_1 = require("./workerMetrics");
const listenerEvents_1 = require("./listenerEvents");
async function writeChannelMessage(supabase, input) {
    const { error } = await supabase.from('channel_messages').upsert({
        signal_channel_id: input.signalChannelId,
        telegram_message_id: input.telegramMessageId,
        raw_message: input.rawMessage,
        reply_to_message_id: input.replyToMessageId ?? null,
        edit_date: input.editDate?.toISOString() ?? null,
        received_at: new Date().toISOString(),
    }, { onConflict: 'signal_channel_id,telegram_message_id' });
    if (error) {
        console.error('[channelCanonicalIngest] channel_messages upsert failed:', error.message);
        return;
    }
    await supabase
        .from('signal_channels')
        .update({ last_live_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', input.signalChannelId);
    (0, channelListenerConfig_1.recordSignalChannelMetric)(input.signalChannelId, 'channel_message_ingested');
}
async function writeChannelSignal(supabase, input) {
    await writeChannelMessage(supabase, {
        signalChannelId: input.signalChannelId,
        telegramMessageId: input.telegramMessageId,
        rawMessage: input.rawMessage,
        replyToMessageId: input.replyToMessageId,
        editDate: input.editDate ?? null,
    });
    const channelSignalId = (0, node_crypto_1.randomUUID)();
    const { data, error } = await supabase
        .from('channel_signals')
        .upsert({
        id: channelSignalId,
        signal_channel_id: input.signalChannelId,
        telegram_message_id: input.telegramMessageId,
        raw_message: input.rawMessage,
        parsed_data: input.parseResult.parsed,
        status: input.parseResult.status,
        skip_reason: input.parseResult.skip_reason,
        parent_message_id: input.replyToMessageId ?? null,
        pipeline_ts: input.pipelineTs ?? null,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'signal_channel_id,telegram_message_id' })
        .select('id, signal_channel_id, telegram_message_id, raw_message, parsed_data, status, skip_reason, parent_message_id, pipeline_ts')
        .single();
    if (error) {
        console.error('[channelCanonicalIngest] channel_signals upsert failed:', error.message);
        return null;
    }
    (0, channelListenerConfig_1.recordSignalChannelMetric)(input.signalChannelId, 'channel_signal_ingested');
    (0, workerMetrics_1.incMetric)('channel_signal_canonical_written');
    return data;
}
function parsedActionMatch(a, b) {
    const actionA = String(a?.action ?? '').toLowerCase();
    const actionB = String(b?.action ?? '').toLowerCase();
    if (actionA !== actionB)
        return false;
    const symA = String(a?.symbol ?? '').toUpperCase();
    const symB = String(b?.symbol ?? '').toUpperCase();
    return symA === symB;
}
/** Compare canonical parse to per-user signal; log shadow mismatches. */
async function compareShadowSignal(supabase, args) {
    const match = parsedActionMatch(args.canonicalParsed, args.userParsed)
        && args.canonicalStatus === args.userStatus;
    if (match) {
        (0, workerMetrics_1.incMetric)('channel_shadow_match');
        (0, channelListenerConfig_1.recordSignalChannelMetric)(args.signalChannelId, 'channel_shadow_match');
        return;
    }
    (0, workerMetrics_1.incMetric)('channel_shadow_mismatch');
    (0, channelListenerConfig_1.recordSignalChannelMetric)(args.signalChannelId, 'channel_shadow_mismatch');
    void (0, listenerEvents_1.persistListenerEvent)(supabase, {
        userId: args.userId,
        eventType: 'channel_shadow_mismatch',
        channelRowId: args.subscriptionRowId,
        telegramMessageId: args.telegramMessageId,
        detail: {
            signal_channel_id: args.signalChannelId,
            canonical_status: args.canonicalStatus,
            user_status: args.userStatus,
            canonical_action: args.canonicalParsed?.action,
            user_action: args.userParsed?.action,
        },
    });
}
/**
 * Handle canonical write after elected reader parses a message.
 * In primary mode, also projects to all subscribers.
 */
async function ingestCanonicalFromReader(supabase, input, dispatch) {
    if (!(0, channelListenerConfig_1.channelListenerShadowMode)() && !(0, channelListenerConfig_1.channelListenerPrimaryMode)()) {
        return { canonical: null, projected: 0 };
    }
    const canonical = await writeChannelSignal(supabase, input);
    if (!canonical)
        return { canonical: null, projected: 0 };
    if ((0, channelListenerConfig_1.channelListenerPrimaryMode)()) {
        const { projected } = await (0, channelSignalProjector_1.projectChannelSignalToSubscribers)(supabase, canonical, dispatch);
        return { canonical, projected };
    }
    return { canonical, projected: 0 };
}
