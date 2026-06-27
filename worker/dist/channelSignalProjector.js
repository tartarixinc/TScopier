"use strict";
/**
 * Project canonical channel_signals → per-user signals + parallel fan-out dispatch.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectChannelSignalToUser = projectChannelSignalToUser;
exports.projectChannelSignalToSubscribers = projectChannelSignalToSubscribers;
exports.projectChannelSignalById = projectChannelSignalById;
const node_crypto_1 = require("node:crypto");
const channelListenerConfig_1 = require("./channelListenerConfig");
const parallelPool_1 = require("./parallelPool");
const workerMetrics_1 = require("./workerMetrics");
async function loadActiveSubscriptions(supabase, signalChannelId) {
    const { data } = await supabase
        .from('telegram_channels')
        .select('id, user_id')
        .eq('signal_channel_id', signalChannelId)
        .eq('is_active', true);
    return (data ?? []);
}
async function resolveParentSignalId(supabase, userId, subscriptionId, parentTelegramMessageId) {
    if (!parentTelegramMessageId)
        return null;
    const { data } = await supabase
        .from('signals')
        .select('id')
        .eq('user_id', userId)
        .eq('channel_id', subscriptionId)
        .eq('telegram_message_id', parentTelegramMessageId)
        .maybeSingle();
    return data?.id ?? null;
}
/** Upsert one canonical signal into a single user's signals table. */
async function projectChannelSignalToUser(supabase, canonical, subscription) {
    const parentSignalId = await resolveParentSignalId(supabase, subscription.user_id, subscription.id, canonical.parent_message_id);
    const { data: existing } = await supabase
        .from('signals')
        .select('id')
        .eq('user_id', subscription.user_id)
        .eq('channel_id', subscription.id)
        .eq('telegram_message_id', canonical.telegram_message_id)
        .maybeSingle();
    const signalId = existing?.id ?? (0, node_crypto_1.randomUUID)();
    const rowPatch = {
        id: signalId,
        user_id: subscription.user_id,
        channel_id: subscription.id,
        channel_signal_id: canonical.id,
        raw_message: canonical.raw_message,
        parsed_data: canonical.parsed_data,
        status: canonical.status,
        skip_reason: canonical.skip_reason,
        telegram_message_id: canonical.telegram_message_id,
        is_modification: Boolean(canonical.parent_message_id),
        parent_signal_id: parentSignalId,
        reply_to_message_id: canonical.parent_message_id,
    };
    const { error } = await supabase.from('signals').upsert(rowPatch, {
        onConflict: 'user_id,channel_id,telegram_message_id',
        ignoreDuplicates: false,
    });
    if (error) {
        console.error(`[channelSignalProjector] upsert failed user=${subscription.user_id} msg=${canonical.telegram_message_id}:`, error.message);
        return null;
    }
    return {
        id: signalId,
        user_id: subscription.user_id,
        channel_id: subscription.id,
        raw_message: canonical.raw_message,
        parsed_data: canonical.parsed_data,
        status: canonical.status,
        skip_reason: canonical.skip_reason,
        telegram_message_id: canonical.telegram_message_id,
        is_modification: Boolean(canonical.parent_message_id),
        parent_signal_id: parentSignalId,
        reply_to_message_id: canonical.parent_message_id,
        dispatch_source: 'channel_projector',
    };
}
/** Fan-out one canonical channel_signal to all active subscriptions. */
async function projectChannelSignalToSubscribers(supabase, canonical, dispatch) {
    const subscriptions = await loadActiveSubscriptions(supabase, canonical.signal_channel_id);
    if (!subscriptions.length)
        return { projected: 0, dispatched: 0 };
    let projected = 0;
    let dispatched = 0;
    await (0, parallelPool_1.parallelMap)(subscriptions, Math.min(12, subscriptions.length), async (sub) => {
        const row = await projectChannelSignalToUser(supabase, canonical, sub);
        if (!row)
            return;
        projected++;
        (0, workerMetrics_1.incMetric)('channel_signal_projected');
        (0, channelListenerConfig_1.recordSignalChannelMetric)(canonical.signal_channel_id, 'channel_signal_projected');
        if (dispatch) {
            const ok = dispatch(row) === true;
            if (ok) {
                dispatched++;
                (0, workerMetrics_1.incMetric)('channel_signal_dispatched');
            }
        }
    });
    return { projected, dispatched };
}
/** Load canonical row by id and project to all subscribers. */
async function projectChannelSignalById(supabase, channelSignalId, dispatch) {
    const { data } = await supabase
        .from('channel_signals')
        .select('id, signal_channel_id, telegram_message_id, raw_message, parsed_data, status, skip_reason, parent_message_id, pipeline_ts')
        .eq('id', channelSignalId)
        .maybeSingle();
    if (!data)
        return { projected: 0, dispatched: 0 };
    return projectChannelSignalToSubscribers(supabase, data, dispatch);
}
