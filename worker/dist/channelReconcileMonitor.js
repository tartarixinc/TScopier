"use strict";
/**
 * One getMessages reconcile pass per signal_channel (elected reader session).
 * Mgmt signals fan out via channelSignalProjector after reconcile detects edits.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelReconcileMonitor = void 0;
exports.loadMgmtFanOutSubscriptions = loadMgmtFanOutSubscriptions;
const channelListenerConfig_1 = require("./channelListenerConfig");
const channelListenerLease_1 = require("./channelListenerLease");
const channelReaderRegistry_1 = require("./channelReaderRegistry");
const workerMetrics_1 = require("./workerMetrics");
const listenerEvents_1 = require("./listenerEvents");
const signalTelegramReconcile_1 = require("./signalTelegramReconcile");
const TICK_MS = Math.max(15000, Math.min(120000, Number(process.env.CHANNEL_RECONCILE_TICK_MS ?? 45000)));
class ChannelReconcileMonitor {
    constructor(supabase, resolveClient) {
        this.supabase = supabase;
        this.resolveClient = resolveClient;
        this.timer = null;
        this.inFlight = false;
    }
    start() {
        if (!(0, channelListenerConfig_1.channelListenerModeEnabled)())
            return;
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.tick();
        }, TICK_MS);
        this.timer.unref?.();
        console.log(`[channelReconcileMonitor] started tickMs=${TICK_MS}`);
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    getLoopHandle() {
        return {
            stop: () => this.stop(),
            poke: () => { void this.tick(); },
        };
    }
    async tick() {
        if (this.inFlight)
            return;
        this.inFlight = true;
        try {
            const { data: channels } = await this.supabase
                .from('signal_channels')
                .select('id, telegram_chat_id, subscriber_count')
                .gt('subscriber_count', 0);
            for (const row of channels ?? []) {
                const ch = row;
                if (!(0, channelReaderRegistry_1.signalChannelBelongsToShard)(ch.id))
                    continue;
                const reader = await (0, channelListenerLease_1.fetchChannelLeaseReader)(this.supabase, ch.id);
                if (!reader)
                    continue;
                await this.reconcileChannel(ch.id, ch.telegram_chat_id, reader).catch(err => {
                    console.warn(`[channelReconcileMonitor] reconcile failed signalChannel=${ch.id}:`, err instanceof Error ? err.message : err);
                });
            }
        }
        finally {
            this.inFlight = false;
        }
    }
    async reconcileChannel(signalChannelId, telegramChatId, readerUserId) {
        const resolved = await this.resolveClient(readerUserId, signalChannelId, telegramChatId);
        if (!resolved)
            return;
        const peer = await resolved.resolvePeer();
        let batch;
        try {
            batch = (await resolved.client.getMessages(peer, { limit: 15 }));
        }
        catch (err) {
            (0, workerMetrics_1.incMetric)('channel_reconcile_get_messages_failed');
            return;
        }
        if (!batch.length)
            return;
        const { data: recentSignals } = await this.supabase
            .from('channel_signals')
            .select('telegram_message_id, raw_message, status')
            .eq('signal_channel_id', signalChannelId)
            .order('created_at', { ascending: false })
            .limit(30);
        const byMsgId = new Map((recentSignals ?? []).map(r => [
            String(r.telegram_message_id),
            r,
        ]));
        let mismatches = 0;
        for (const msg of batch) {
            const msgId = String(msg.id);
            const liveText = (0, signalTelegramReconcile_1.telegramMessageText)(msg);
            const stored = byMsgId.get(msgId);
            if (!stored)
                continue;
            if (stored.raw_message.trim() === liveText.trim())
                continue;
            mismatches++;
            (0, channelListenerConfig_1.recordSignalChannelMetric)(signalChannelId, 'channel_reconcile_mismatch');
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: readerUserId,
                eventType: 'channel_reconcile_mismatch',
                telegramMessageId: msgId,
                detail: {
                    signal_channel_id: signalChannelId,
                    stored_len: stored.raw_message.length,
                    live_len: liveText.length,
                },
            });
            await this.supabase
                .from('channel_messages')
                .upsert({
                signal_channel_id: signalChannelId,
                telegram_message_id: msgId,
                raw_message: liveText,
                received_at: new Date().toISOString(),
            }, { onConflict: 'signal_channel_id,telegram_message_id' });
        }
        if (mismatches > 0) {
            (0, workerMetrics_1.incMetric)('channel_reconcile_mismatch', mismatches);
            console.log(`[channelReconcileMonitor] signalChannel=${signalChannelId} mismatches=${mismatches}`);
        }
        else {
            (0, workerMetrics_1.incMetric)('channel_reconcile_checked');
        }
    }
}
exports.ChannelReconcileMonitor = ChannelReconcileMonitor;
/** Batch fan-out hint for management: all active subscriptions on a signal_channel. */
async function loadMgmtFanOutSubscriptions(supabase, signalChannelId) {
    const { data } = await supabase
        .from('telegram_channels')
        .select('id, user_id')
        .eq('signal_channel_id', signalChannelId)
        .eq('is_active', true);
    return (data ?? []).map(r => ({
        subscriptionId: r.id,
        userId: r.user_id,
    }));
}
