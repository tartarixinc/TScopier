"use strict";
/**
 * Channel listener manager — WORKER_ROLE=channel_listener coordination.
 * Telethon alignment: set LISTENER_ENGINE=telethon on telethon service; both
 * engines use the same signal_channels registry + channel_listener_leases protocol.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TELETHON_CHANNEL_LISTENER_NOTES = exports.ChannelListenerManager = void 0;
const channelRegistry_1 = require("./channelRegistry");
const channelListenerConfig_1 = require("./channelListenerConfig");
const channelReaderRegistry_1 = require("./channelReaderRegistry");
const workerConfig_1 = require("./workerConfig");
class ChannelListenerManager {
    constructor(supabase) {
        this.supabase = supabase;
        this.syncTimer = null;
    }
    async startup() {
        if (!this.shouldRun())
            return;
        const linked = await (0, channelRegistry_1.backfillUnlinkedSubscriptions)(this.supabase);
        if (linked > 0) {
            console.log(`[channelListenerManager] backfilled ${linked} unlinked subscriptions`);
        }
        const { elected, total } = await (0, channelReaderRegistry_1.syncChannelReaders)(this.supabase);
        console.log(`[channelListenerManager] startup enrolled=${total} newlyElected=${elected}`
            + ` mode=${process.env.CHANNEL_LISTENER_MODE ?? 'off'}`);
    }
    startPeriodicSync() {
        if (!this.shouldRun())
            return;
        if (this.syncTimer)
            return;
        const intervalMs = Math.max(15000, Math.min(120000, Number(process.env.CHANNEL_LISTENER_SYNC_MS ?? 30000)));
        this.syncTimer = setInterval(() => {
            void this.syncCycle();
        }, intervalMs);
        this.syncTimer.unref?.();
    }
    stop() {
        if (this.syncTimer)
            clearInterval(this.syncTimer);
        this.syncTimer = null;
    }
    shouldRun() {
        if (!(0, channelListenerConfig_1.channelListenerModeEnabled)())
            return false;
        return workerConfig_1.workerConfig.runsChannelListener || workerConfig_1.workerConfig.runsListener;
    }
    async syncCycle() {
        await (0, channelReaderRegistry_1.syncChannelReaders)(this.supabase);
        const channels = await (0, channelReaderRegistry_1.listEnrolledSignalChannels)(this.supabase);
        for (const ch of channels) {
            (0, channelListenerConfig_1.recordSignalChannelMetric)(ch.signalChannelId, 'channel_listener_sync');
            if (ch.readerUserId) {
                await (0, channelReaderRegistry_1.renewChannelLeasesForReader)(this.supabase, ch.readerUserId);
            }
        }
    }
}
exports.ChannelListenerManager = ChannelListenerManager;
/** Telethon service hook: same registry protocol documented for Python listener. */
exports.TELETHON_CHANNEL_LISTENER_NOTES = `
Telethon alignment (telegram-listener/):
- Upsert signal_channels on channel discovery (telegram_chat_id canonical -100… form)
- Acquire channel_listener_leases via elected subscriber session
- Write channel_messages + channel_signals on ingest
- Honor CHANNEL_LISTENER_MODE (off/shadow/primary) and CHANNEL_LISTENER_ALLOWLIST
- Passive subscribers skip poll when canonical feed is live (primary mode)
`.trim();
