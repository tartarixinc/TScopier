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
const tradeSignalActions_1 = require("./tradeSignalActions");
function listenerInProcessDispatch(executor, row) {
    return executor.acceptDispatchSignal(row, {
        priority: (0, tradeSignalActions_1.dispatchPriorityForAction)((0, tradeSignalActions_1.parsedAction)(row.parsed_data)),
        source: row.dispatch_source ?? 'in_process',
    });
}
function gramjsListenerEnabled() {
    const engine = String(process.env.LISTENER_ENGINE ?? 'gramjs').toLowerCase().trim();
    return engine !== 'telethon';
}
function shouldRunGramjsForSession(session) {
    if (!gramjsListenerEnabled())
        return false;
    const engine = String(session.listener_engine ?? 'gramjs').toLowerCase().trim();
    return engine !== 'telethon';
}
/** Wait after disconnect so Telegram releases the auth key before a new connect. */
function authKeyReleaseDelayMs() {
    return Math.max(500, Math.min(120000, Number(process.env.TELEGRAM_RECONNECT_COOLDOWN_MS ?? 3500)));
}
class UserSessionManager {
    constructor(supabase) {
        this.listeners = new Map();
        this.channelChannel = null;
        this.authPendingChannel = null;
        this.tradeExecutor = null;
        /** Serializes start/stop/adopt for one user — prevents AUTH_KEY_DUPLICATED races. */
        this.userConnectionLocks = new Map();
        /** True while adoptClient is handing off the auth-time MTProto socket. */
        this.adoptingUsers = new Set();
        this.authGuard = null;
        this.supabase = supabase;
    }
    /** In-memory pending auth check (send_code → verify_code window on this process). */
    setAuthGuard(fn) {
        this.authGuard = fn;
    }
    async withConnectionLock(userId, fn) {
        const prev = this.userConnectionLocks.get(userId) ?? Promise.resolve();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const chain = prev.then(() => gate);
        this.userConnectionLocks.set(userId, chain);
        try {
            await prev;
            return await fn();
        }
        finally {
            release();
            if (this.userConnectionLocks.get(userId) === chain) {
                this.userConnectionLocks.delete(userId);
            }
        }
    }
    isAuthBlocked(userId) {
        return this.adoptingUsers.has(userId) || Boolean(this.authGuard?.(userId));
    }
    async hasActivePendingAuthInDb(userId) {
        const { data } = await this.supabase
            .from('telegram_auth_pending')
            .select('user_id')
            .eq('user_id', userId)
            .gt('expires_at', new Date().toISOString())
            .maybeSingle();
        return Boolean(data);
    }
    async shouldSkipListenerStart(userId) {
        if (this.isAuthBlocked(userId))
            return true;
        return this.hasActivePendingAuthInDb(userId);
    }
    getSupabase() {
        return this.supabase;
    }
    setTradeExecutor(executor) {
        this.tradeExecutor = executor;
        for (const listener of this.listeners.values()) {
            listener.setOnSignalParsed(executor ? row => listenerInProcessDispatch(executor, row) : null);
        }
    }
    async loadAll() {
        if (!workerConfig_1.workerConfig.runsListener)
            return;
        if (!gramjsListenerEnabled()) {
            console.log('[sessionManager] LISTENER_ENGINE=telethon — gramjs listener disabled on this service');
            return;
        }
        const { data: sessions, error } = await this.supabase
            .from('telegram_sessions')
            .select('user_id, session_string, phone_number, listener_engine')
            .eq('is_active', true);
        if (error) {
            console.error('[sessionManager] Failed to load sessions:', error.message);
            return;
        }
        const owned = (sessions ?? []).filter(s => (0, workerConfig_1.userBelongsToShard)(s.user_id) && shouldRunGramjsForSession(s));
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
        this.subscribeToAuthPendingChanges();
    }
    async renewAllLeases() {
        const staleMs = Math.max(60000, Math.min(600000, Number(process.env.WORKER_HEALTH_STALE_MS ?? 180000)));
        for (const [userId, listener] of this.listeners) {
            if (!listener.isListenerHealthy(staleMs)) {
                console.warn(`[sessionManager] skip lease renew — listener stale user=${userId}`);
                continue;
            }
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
    subscribeToAuthPendingChanges() {
        if (this.authPendingChannel)
            return;
        this.authPendingChannel = this.supabase
            .channel('telegram_auth_pending_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'telegram_auth_pending' }, (payload) => {
            const userId = (payload.new?.user_id ?? payload.old?.user_id);
            if (!userId || !(0, workerConfig_1.userBelongsToShard)(userId))
                return;
            if (payload.eventType === 'DELETE') {
                void this.onAuthPendingCleared(userId);
                return;
            }
            void this.stopListenerForPendingAuth(userId);
        })
            .subscribe(status => {
            if (status === 'SUBSCRIBED') {
                console.log('[sessionManager] Realtime telegram_auth_pending subscription active');
            }
            else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                console.warn(`[sessionManager] telegram_auth_pending subscription status: ${status}`);
            }
        });
    }
    /** Stop the live listener before send_code so the auth key slot is free on this host. */
    async pauseForAuth(userId, opts) {
        if (!workerConfig_1.workerConfig.runsListener)
            return;
        await this.withConnectionLock(userId, async () => {
            await this.disconnectListener(userId);
            if (opts?.releaseDelay === false)
                return;
            const delay = authKeyReleaseDelayMs();
            if (delay > 0)
                await new Promise(r => setTimeout(r, delay));
        });
    }
    async stopListenerForPendingAuth(userId) {
        if (!this.listeners.has(userId))
            return;
        console.log(`[sessionManager] stopping listener for ${userId} — telegram auth in progress`);
        await this.withConnectionLock(userId, async () => {
            await this.disconnectListener(userId);
        });
    }
    async onAuthPendingCleared(userId) {
        // Debounce: send_code clears pending before inserting the new row.
        await new Promise(r => setTimeout(r, 2500));
        if (this.listeners.has(userId) || this.isAuthBlocked(userId))
            return;
        if (await this.hasActivePendingAuthInDb(userId))
            return;
        const { data: sess } = await this.supabase
            .from('telegram_sessions')
            .select('session_string, is_active, listener_engine')
            .eq('user_id', userId)
            .maybeSingle();
        if (!sess?.session_string || !sess.is_active || !shouldRunGramjsForSession(sess))
            return;
        try {
            await this.startListener(userId, sess.session_string);
        }
        catch (err) {
            console.warn(`[sessionManager] restart after auth cleared failed for ${userId}:`, err);
        }
    }
    async syncSessions() {
        if (!workerConfig_1.workerConfig.runsListener)
            return;
        const { data: sessions } = await this.supabase
            .from('telegram_sessions')
            .select('user_id, session_string, is_active, listener_engine');
        const activeOnShard = (sessions ?? []).filter(s => s.is_active && (0, workerConfig_1.userBelongsToShard)(s.user_id) && shouldRunGramjsForSession(s));
        const activeSessions = new Set(activeOnShard.map(s => s.user_id));
        for (const [userId] of this.listeners) {
            if (!activeSessions.has(userId) || await this.hasActivePendingAuthInDb(userId)) {
                await this.stopListener(userId);
            }
        }
        for (const session of activeOnShard) {
            if (this.listeners.has(session.user_id))
                continue;
            if (await this.shouldSkipListenerStart(session.user_id))
                continue;
            try {
                await this.startListener(session.user_id, session.session_string);
            }
            catch (err) {
                console.error(`[sessionManager] Failed to start listener for ${session.user_id}:`, err);
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
        return this.withConnectionLock(userId, async () => {
            this.adoptingUsers.add(userId);
            try {
                await this.disconnectListener(userId);
                const lease = await (0, sessionLease_1.acquireSessionLease)(this.supabase, userId);
                if (!lease.ok) {
                    throw new Error(`Cannot adopt Telegram client: ${lease.reason}`);
                }
                const listener = new userListener_1.UserListener(userId, sessionString, this.supabase, client);
                if (this.tradeExecutor) {
                    listener.setOnSignalParsed(row => listenerInProcessDispatch(this.tradeExecutor, row));
                }
                try {
                    await listener.start({ alreadyConnected: true });
                }
                catch (err) {
                    await (0, sessionLease_1.releaseSessionLease)(this.supabase, userId);
                    throw err;
                }
                this.listeners.set(userId, listener);
                console.log(`[sessionManager] Adopted live client for user ${userId}`);
            }
            catch (err) {
                try {
                    await client.disconnect();
                }
                catch { /* ignore */ }
                throw err;
            }
            finally {
                this.adoptingUsers.delete(userId);
            }
        });
    }
    /** List channels on the listener adoptClient just registered — never opens a second MTProto socket. */
    async listChannelsForAdoptedUser(userId, opts) {
        const listener = this.listeners.get(userId);
        if (!listener)
            throw new Error('No listener after Telegram auth');
        return listener.listChannels(opts);
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
        const existing = this.listeners.get(userId);
        if (existing)
            return existing;
        if (!workerConfig_1.workerConfig.runsListener) {
            throw new Error('Live Telegram listener not available on this worker');
        }
        if (await this.shouldSkipListenerStart(userId)) {
            throw new Error('Telegram auth is in progress. Finish linking, then try again.');
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
        const listener = this.listeners.get(userId);
        if (!listener)
            throw new Error('Failed to start listener for user');
        return listener;
    }
    async backfillChannelHistory(userId, channelRowId, days, opts) {
        // Prefer the live listener (listener-only deploys). Avoids a second MTProto
        // connection that would trigger AUTH_KEY_DUPLICATED.
        if (workerConfig_1.workerConfig.runsListener) {
            let listener = this.listeners.get(userId);
            if (!listener?.isTelegramConnected()) {
                try {
                    listener = await this.ensureListener(userId);
                }
                catch {
                    listener = undefined;
                }
            }
            if (listener?.isTelegramConnected()) {
                return listener.backfillChannelHistory(channelRowId, days, opts);
            }
        }
        if (!workerConfig_1.workerConfig.runsBacktestHttp) {
            throw new Error('Telegram listener is not connected. Link Telegram on Copier Engine, wait a few seconds, then refresh.');
        }
        return this.withEphemeralTelegram(userId, () => (0, backtestSync_1.runWithEphemeralListener)(this.supabase, userId, listener => listener.backfillChannelHistory(channelRowId, days, opts)));
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
        if (await this.shouldSkipListenerStart(userId)) {
            console.log(`[sessionManager] skip listener for ${userId}: auth in progress`);
            return;
        }
        await this.withConnectionLock(userId, async () => {
            if (this.listeners.has(userId))
                return;
            if (await this.shouldSkipListenerStart(userId))
                return;
            const lease = await (0, sessionLease_1.acquireSessionLease)(this.supabase, userId);
            if (!lease.ok) {
                console.warn(`[sessionManager] skip listener for ${userId}: ${lease.reason}`);
                return;
            }
            const listener = new userListener_1.UserListener(userId, sessionString, this.supabase);
            if (this.tradeExecutor) {
                listener.setOnSignalParsed(row => listenerInProcessDispatch(this.tradeExecutor, row));
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
        });
    }
    async disconnectListener(userId) {
        const listener = this.listeners.get(userId);
        if (!listener)
            return;
        await listener.stop();
        this.listeners.delete(userId);
        await (0, sessionLease_1.releaseSessionLease)(this.supabase, userId);
        console.log(`[sessionManager] Stopped listener for user ${userId}`);
    }
    async stopListener(userId) {
        await this.withConnectionLock(userId, async () => {
            await this.disconnectListener(userId);
        });
    }
    async reconcileUserSignals(userId, opts) {
        if (!(0, workerConfig_1.userBelongsToShard)(userId)) {
            return { ok: false, reason: 'wrong_shard' };
        }
        const listener = this.listeners.get(userId);
        if (!listener) {
            return { ok: false, reason: 'listener_not_running' };
        }
        let channelRow;
        if (opts?.channelRowId) {
            const { data } = await this.supabase
                .from('telegram_channels')
                .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
                .eq('id', opts.channelRowId)
                .eq('user_id', userId)
                .maybeSingle();
            if (data)
                channelRow = data;
        }
        const stats = await listener.runSignalTelegramReconcile('cron', channelRow);
        return { ok: true, stats };
    }
    async reconcileAllListenersOnShard() {
        const totals = { checked: 0, mismatches: 0, revised: 0, errors: 0 };
        let users = 0;
        for (const [, listener] of this.listeners) {
            users += 1;
            const stats = await listener.runSignalTelegramReconcile('cron');
            totals.checked += stats.checked;
            totals.mismatches += stats.mismatches;
            totals.revised += stats.revised;
            totals.errors += stats.errors;
        }
        return { users, stats: totals };
    }
    async disconnectAll() {
        if (this.channelChannel) {
            try {
                await this.supabase.removeChannel(this.channelChannel);
            }
            catch { /* noop */ }
            this.channelChannel = null;
        }
        if (this.authPendingChannel) {
            try {
                await this.supabase.removeChannel(this.authPendingChannel);
            }
            catch { /* noop */ }
            this.authPendingChannel = null;
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
