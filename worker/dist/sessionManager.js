"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserSessionManager = exports.TelegramSessionInvalidError = void 0;
const backtestSync_1 = require("./backtestSync");
const telegramClient_1 = require("./telegramClient");
Object.defineProperty(exports, "TelegramSessionInvalidError", { enumerable: true, get: function () { return telegramClient_1.TelegramSessionInvalidError; } });
const userListener_1 = require("./userListener");
const sessionLease_1 = require("./sessionLease");
const workerMetrics_1 = require("./workerMetrics");
const workerConfig_1 = require("./workerConfig");
class UserSessionManager {
    constructor(supabase) {
        this.listeners = new Map();
        this.channelChannel = null;
        this.tradeExecutor = null;
        this.supabase = supabase;
    }
    setTradeExecutor(executor) {
        this.tradeExecutor = executor;
        for (const listener of this.listeners.values()) {
            listener.setOnSignalParsed(executor ? row => executor.dispatchParsedSignal(row) : null);
        }
    }
    async loadAll() {
        if (!workerConfig_1.workerConfig.runsListener)
            return;
        const { data: sessions, error } = await this.supabase
            .from('telegram_sessions')
            .select('user_id, session_string, phone_number')
            .eq('is_active', true);
        if (error) {
            console.error('[sessionManager] Failed to load sessions:', error.message);
            return;
        }
        const owned = (sessions ?? []).filter(s => (0, workerConfig_1.userBelongsToShard)(s.user_id));
        console.log(`[sessionManager] Loading ${owned.length}/${sessions?.length ?? 0} sessions`
            + ` (shard ${workerConfig_1.workerConfig.shardId}/${workerConfig_1.workerConfig.shardCount})`);
        const staggerMs = Math.max(0, Math.min(30000, Number(process.env.TELEGRAM_MULTI_SESSION_STAGGER_MS ?? 600)));
        let i = 0;
        for (const session of owned) {
            if (i++ > 0 && staggerMs > 0) {
                await new Promise(r => setTimeout(r, staggerMs));
            }
            try {
                await this.startListener(session.user_id, session.session_string);
            }
            catch (err) {
                console.error(`[sessionManager] Failed to start listener for ${session.user_id}:`, err);
            }
        }
        this.subscribeToChannelChanges();
    }
    async renewAllLeases() {
        for (const userId of this.listeners.keys()) {
            await (0, sessionLease_1.renewSessionLease)(this.supabase, userId).catch(err => console.warn(`[sessionManager] lease renew failed ${userId}:`, err));
        }
    }
    subscribeToChannelChanges() {
        if (this.channelChannel)
            return;
        this.channelChannel = this.supabase
            .channel('telegram_channels_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'telegram_channels' }, (payload) => {
            const userId = (payload.new?.user_id ?? payload.old?.user_id);
            if (!userId)
                return;
            if (!(0, workerConfig_1.userBelongsToShard)(userId))
                return;
            const listener = this.listeners.get(userId);
            if (!listener)
                return;
            listener.onChannelsChanged().catch(err => console.error(`[sessionManager] onChannelsChanged failed for ${userId}:`, err));
        })
            .subscribe(status => {
            if (status === 'SUBSCRIBED') {
                console.log('[sessionManager] Realtime telegram_channels subscription active');
            }
            else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                console.warn(`[sessionManager] Realtime subscription status: ${status}`);
            }
        });
    }
    async syncSessions() {
        if (!workerConfig_1.workerConfig.runsListener)
            return;
        const { data: sessions } = await this.supabase
            .from('telegram_sessions')
            .select('user_id, session_string, is_active');
        const activeOnShard = (sessions ?? []).filter(s => s.is_active && (0, workerConfig_1.userBelongsToShard)(s.user_id));
        const activeSessions = new Set(activeOnShard.map(s => s.user_id));
        for (const session of activeOnShard) {
            if (!this.listeners.has(session.user_id)) {
                try {
                    await this.startListener(session.user_id, session.session_string);
                }
                catch (err) {
                    console.error(`[sessionManager] Failed to start listener for ${session.user_id}:`, err);
                }
            }
        }
        for (const [userId] of this.listeners) {
            if (!activeSessions.has(userId)) {
                await this.stopListener(userId);
            }
        }
    }
    hasListener(userId) {
        return this.listeners.has(userId);
    }
    canExecuteTelegramCopierTrades(userId) {
        if (workerConfig_1.workerConfig.runsListener) {
            const listener = this.listeners.get(userId);
            if (listener?.isTelegramConnected())
                return true;
        }
        return false;
    }
    /** Async lease check for trade-only workers. */
    async canExecuteTelegramCopierTradesAsync(userId) {
        if (workerConfig_1.workerConfig.runsListener) {
            return this.canExecuteTelegramCopierTrades(userId);
        }
        const { isTelegramListenerLiveForUser } = await Promise.resolve().then(() => __importStar(require('./sessionLease')));
        return isTelegramListenerLiveForUser(this.supabase, userId);
    }
    getStatus() {
        const out = [];
        for (const [, listener] of this.listeners) {
            out.push(listener.getStatus());
        }
        return out;
    }
    async getHealthPayload() {
        const status = this.getStatus();
        const now = Date.now();
        const staleMs = Math.max(60000, Math.min(600000, Number(process.env.WORKER_HEALTH_STALE_MS ?? 180000)));
        const listenerOk = !workerConfig_1.workerConfig.runsListener
            || status.length === 0
            || status.every(s => s.connected && (s.last_event_at === 0 || now - s.last_event_at < staleMs));
        const leases = workerConfig_1.workerConfig.runsListener
            ? await (0, sessionLease_1.listActiveLeases)(this.supabase)
            : [];
        return {
            ok: listenerOk,
            role: workerConfig_1.workerConfig.role,
            shard: `${workerConfig_1.workerConfig.shardId}/${workerConfig_1.workerConfig.shardCount}`,
            instance: workerConfig_1.workerConfig.instanceId,
            listeners: status.length,
            detail: status,
            active_leases: leases.length,
            metrics: (0, workerMetrics_1.getMetricsSnapshot)(),
            checked_at: new Date(now).toISOString(),
        };
    }
    async adoptClient(userId, client, sessionString) {
        if (!workerConfig_1.workerConfig.runsListener) {
            throw new Error('Telegram listener not enabled on this worker (WORKER_ROLE)');
        }
        await this.stopListener(userId);
        const listener = new userListener_1.UserListener(userId, sessionString, this.supabase, client);
        if (this.tradeExecutor) {
            listener.setOnSignalParsed(row => this.tradeExecutor.dispatchParsedSignal(row));
        }
        await listener.start({ alreadyConnected: true });
        this.listeners.set(userId, listener);
        await (0, sessionLease_1.acquireSessionLease)(this.supabase, userId);
        console.log(`[sessionManager] Adopted live client for user ${userId}`);
    }
    /**
     * Telegram revoked the auth key (AUTH_KEY_UNREGISTERED). Drop the dead session
     * so we stop reconnect loops, but keep configured telegram_channels — the user
     * reconnects manually without re-adding channels.
     */
    async invalidateTelegramSession(userId) {
        await this.stopListener(userId);
        await (0, sessionLease_1.releaseSessionLease)(this.supabase, userId);
        await this.supabase.from('telegram_auth_pending').delete().eq('user_id', userId);
        const { error } = await this.supabase.from('telegram_sessions').delete().eq('user_id', userId);
        if (error) {
            console.warn(`[sessionManager] invalidateTelegramSession session delete failed for ${userId}:`, error.message);
        }
    }
    async listChannels(userId, opts) {
        const listener = await this.ensureListener(userId);
        return listener.listChannels(opts);
    }
    async ensureListener(userId) {
        let listener = this.listeners.get(userId);
        if (listener)
            return listener;
        if (!workerConfig_1.workerConfig.runsListener) {
            throw new Error('Live Telegram listener not available on this worker');
        }
        const { data: sess, error } = await this.supabase
            .from('telegram_sessions')
            .select('session_string, is_active')
            .eq('user_id', userId)
            .maybeSingle();
        if (error)
            throw new Error(`Failed to load session: ${error.message}`);
        if (!sess?.session_string)
            throw new Error('No Telegram session for this user');
        if (!sess.is_active)
            throw new Error('Telegram session is paused');
        await this.startListener(userId, sess.session_string);
        listener = this.listeners.get(userId);
        if (!listener)
            throw new Error('Failed to start listener for user');
        return listener;
    }
    async backfillChannelHistory(userId, channelRowId, days) {
        if (!workerConfig_1.workerConfig.runsBacktestHttp) {
            throw new Error('Backtest not enabled on this worker');
        }
        return this.withEphemeralTelegram(userId, () => (0, backtestSync_1.runWithEphemeralListener)(this.supabase, userId, listener => listener.backfillChannelHistory(channelRowId, days)));
    }
    async importBacktestChannelHistory(userId, channelRowId, fromIso, toIso) {
        if (!workerConfig_1.workerConfig.runsBacktestHttp) {
            throw new Error('Backtest not enabled on this worker');
        }
        return this.withEphemeralTelegram(userId, () => (0, backtestSync_1.runWithEphemeralListener)(this.supabase, userId, listener => listener.importBacktestChannelHistory(channelRowId, fromIso, toIso)));
    }
    async syncBacktestSignals(userId, channelRowId, fromIso, toIso, runId) {
        if (!workerConfig_1.workerConfig.runsBacktestHttp) {
            throw new Error('Backtest sync is not enabled on this worker. Use a WORKER_ROLE=backtest or all service.');
        }
        if (workerConfig_1.workerConfig.role === 'listener') {
            throw new Error('Backtest sync blocked on listener-only workers. Point BACKTEST_WORKER_URL to a backtest service.');
        }
        return this.withEphemeralTelegram(userId, () => (0, backtestSync_1.runEphemeralBacktestSync)(this.supabase, userId, channelRowId, fromIso, toIso, runId));
    }
    /**
     * Runs fn while the live listener is stopped (if any) so backtest can use the sole MTProto slot.
     */
    async withEphemeralTelegram(userId, fn) {
        const pauseLive = workerConfig_1.workerConfig.runsListener
            && (workerConfig_1.workerConfig.role === 'all' || process.env.BACKTEST_PAUSE_LIVE_LISTENER !== 'false');
        let sessionString = null;
        if (pauseLive && this.listeners.has(userId)) {
            sessionString = (await this.supabase
                .from('telegram_sessions')
                .select('session_string')
                .eq('user_id', userId)
                .maybeSingle()).data?.session_string ?? null;
            console.log(`[sessionManager] pausing live listener for backtest user=${userId}`);
            await this.stopListener(userId);
            await new Promise(r => setTimeout(r, 2000));
        }
        try {
            return await fn();
        }
        finally {
            if (pauseLive && sessionString) {
                await this.startListener(userId, sessionString);
            }
        }
    }
    async startListener(userId, sessionString) {
        if (this.listeners.has(userId))
            return;
        if (!(0, workerConfig_1.userBelongsToShard)(userId))
            return;
        const lease = await (0, sessionLease_1.acquireSessionLease)(this.supabase, userId);
        if (!lease.ok) {
            console.warn(`[sessionManager] skip listener for ${userId}: ${lease.reason}`);
            return;
        }
        const listener = new userListener_1.UserListener(userId, sessionString, this.supabase);
        if (this.tradeExecutor) {
            listener.setOnSignalParsed(row => this.tradeExecutor.dispatchParsedSignal(row));
        }
        try {
            await listener.start();
        }
        catch (err) {
            await (0, sessionLease_1.releaseSessionLease)(this.supabase, userId);
            if (err instanceof telegramClient_1.TelegramSessionInvalidError) {
                await this.invalidateTelegramSession(userId);
            }
            throw err;
        }
        this.listeners.set(userId, listener);
        console.log(`[sessionManager] Started listener for user ${userId}`);
    }
    async stopListener(userId) {
        const listener = this.listeners.get(userId);
        if (!listener)
            return;
        await listener.stop();
        this.listeners.delete(userId);
        await (0, sessionLease_1.releaseSessionLease)(this.supabase, userId);
        console.log(`[sessionManager] Stopped listener for user ${userId}`);
    }
    async disconnectAll() {
        if (this.channelChannel) {
            try {
                await this.supabase.removeChannel(this.channelChannel);
            }
            catch { /* noop */ }
            this.channelChannel = null;
        }
        for (const [userId, listener] of this.listeners) {
            await listener.stop();
            await (0, sessionLease_1.releaseSessionLease)(this.supabase, userId);
            console.log(`[sessionManager] Disconnected ${userId}`);
        }
        this.listeners.clear();
    }
}
exports.UserSessionManager = UserSessionManager;
