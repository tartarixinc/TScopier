"use strict";
/**
 * Permanent signal_channels registry + subscription linking + inherit-on-add.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveOrCreateSignalChannel = resolveOrCreateSignalChannel;
exports.linkSubscriptionToSignalChannel = linkSubscriptionToSignalChannel;
exports.ensureSubscriptionLinked = ensureSubscriptionLinked;
exports.inheritChannelHistory = inheritChannelHistory;
exports.onChannelSubscriptionAdded = onChannelSubscriptionAdded;
exports.backfillUnlinkedSubscriptions = backfillUnlinkedSubscriptions;
const node_crypto_1 = require("node:crypto");
const telegramChatId_1 = require("./telegramChatId");
const channelListenerConfig_1 = require("./channelListenerConfig");
/** Upsert permanent registry row; reuse existing channel when telegram_chat_id matches. */
async function resolveOrCreateSignalChannel(supabase, input) {
    const rawChatId = String(input.telegramChatId ?? '').trim();
    const telegramChatId = (0, telegramChatId_1.isNumericTelegramChatId)(rawChatId)
        ? (0, telegramChatId_1.normalizeTelegramChatId)(rawChatId)
        : rawChatId;
    if (!telegramChatId)
        return null;
    const username = String(input.channelUsername ?? '').trim().replace(/^@/, '').toLowerCase();
    const displayName = String(input.displayName ?? '').trim() || telegramChatId;
    const { data, error } = await supabase
        .from('signal_channels')
        .upsert({
        telegram_chat_id: telegramChatId,
        channel_username: username,
        display_name: displayName,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'telegram_chat_id' })
        .select('id, telegram_chat_id, channel_username, display_name, subscriber_count, last_live_at')
        .single();
    if (error) {
        console.error('[channelRegistry] resolveOrCreateSignalChannel failed:', error.message);
        return null;
    }
    (0, channelListenerConfig_1.recordSignalChannelMetric)(data.id, 'signal_channel_registry_upsert');
    return data;
}
/** Link telegram_channels subscription row to registry (returns signal_channel_id). */
async function linkSubscriptionToSignalChannel(supabase, subscriptionRowId, signalChannelId) {
    const { error } = await supabase
        .from('telegram_channels')
        .update({ signal_channel_id: signalChannelId, updated_at: new Date().toISOString() })
        .eq('id', subscriptionRowId)
        .is('signal_channel_id', null);
    if (error) {
        console.error('[channelRegistry] linkSubscription failed:', error.message);
        return false;
    }
    return true;
}
/** Ensure subscription has signal_channel_id; upsert registry if needed. */
async function ensureSubscriptionLinked(supabase, args) {
    const { data: existing } = await supabase
        .from('telegram_channels')
        .select('signal_channel_id')
        .eq('id', args.subscriptionRowId)
        .maybeSingle();
    const linked = existing?.signal_channel_id;
    if (linked)
        return linked;
    const registry = await resolveOrCreateSignalChannel(supabase, {
        telegramChatId: args.telegramChatId,
        channelUsername: args.channelUsername,
        displayName: args.displayName,
    });
    if (!registry)
        return null;
    const { error } = await supabase
        .from('telegram_channels')
        .update({ signal_channel_id: registry.id, updated_at: new Date().toISOString() })
        .eq('id', args.subscriptionRowId)
        .eq('user_id', args.userId);
    if (error) {
        console.error('[channelRegistry] ensureSubscriptionLinked update failed:', error.message);
        return null;
    }
    return registry.id;
}
/** Project recent canonical channel_signals into user signals for management context. */
async function inheritChannelHistory(supabase, userId, signalChannelId, opts) {
    const hours = opts?.backfillHours ?? channelListenerConfig_1.channelListenerConfig.inheritBackfillHours;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data: subscription } = await supabase
        .from('telegram_channels')
        .select('id')
        .eq('user_id', userId)
        .eq('signal_channel_id', signalChannelId)
        .eq('is_active', true)
        .maybeSingle();
    const subscriptionId = subscription?.id;
    if (!subscriptionId)
        return { projected: 0 };
    const { data: canonicalRows } = await supabase
        .from('channel_signals')
        .select('id, telegram_message_id, raw_message, parsed_data, status, skip_reason, parent_message_id, pipeline_ts, created_at')
        .eq('signal_channel_id', signalChannelId)
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(500);
    let projected = 0;
    for (const row of canonicalRows ?? []) {
        const r = row;
        const signalId = (0, node_crypto_1.randomUUID)();
        const { error } = await supabase.from('signals').upsert({
            id: signalId,
            user_id: userId,
            channel_id: subscriptionId,
            channel_signal_id: r.id,
            raw_message: r.raw_message,
            parsed_data: r.parsed_data,
            status: r.status,
            skip_reason: r.skip_reason,
            telegram_message_id: r.telegram_message_id,
            reply_to_message_id: r.parent_message_id,
            is_modification: Boolean(r.parent_message_id),
        }, { onConflict: 'user_id,channel_id,telegram_message_id', ignoreDuplicates: true });
        if (!error)
            projected++;
    }
    if (projected > 0) {
        (0, channelListenerConfig_1.recordSignalChannelMetric)(signalChannelId, 'channel_inherit_backfill', projected);
        console.log(`[channelRegistry] inheritChannelHistory user=${userId} signalChannel=${signalChannelId} projected=${projected}`);
    }
    return { projected };
}
/** Full add-channel hook: registry upsert + subscription link + optional backfill. */
async function onChannelSubscriptionAdded(supabase, args) {
    const signalChannelId = await ensureSubscriptionLinked(supabase, args);
    if (!signalChannelId)
        return { signalChannelId: null, inherited: 0 };
    let inherited = 0;
    if (args.inheritHistory !== false) {
        const result = await inheritChannelHistory(supabase, args.userId, signalChannelId);
        inherited = result.projected;
    }
    return { signalChannelId, inherited };
}
/** Backfill unlinked active subscriptions (worker startup hygiene). */
async function backfillUnlinkedSubscriptions(supabase) {
    const { data: rows } = await supabase
        .from('telegram_channels')
        .select('id, user_id, channel_id, channel_username, display_name')
        .eq('is_active', true)
        .is('signal_channel_id', null)
        .limit(200);
    let linked = 0;
    for (const row of rows ?? []) {
        const r = row;
        if (!(0, telegramChatId_1.isNumericTelegramChatId)(r.channel_id))
            continue;
        const id = await ensureSubscriptionLinked(supabase, {
            userId: r.user_id,
            subscriptionRowId: r.id,
            telegramChatId: r.channel_id,
            channelUsername: r.channel_username,
            displayName: r.display_name,
        });
        if (id)
            linked++;
    }
    return linked;
}
