"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserSessionManager = void 0;
const userListener_1 = require("./userListener");
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
            listener.setOnSignalParsed(row => executor.dispatchParsedSignal(row));
        }
    }
    async loadAll() {
        const { data: sessions, error } = await this.supabase
            .from('telegram_sessions')
            .select('user_id, session_string, phone_number')
            .eq('is_active', true);
        if (error) {
            console.error('[sessionManager] Failed to load sessions:', error.message);
            return;
        }
        console.log(`[sessionManager] Loading ${sessions?.length ?? 0} sessions`);
        const staggerMs = Math.max(0, Math.min(30000, Number(process.env.TELEGRAM_MULTI_SESSION_STAGGER_MS ?? 600)));
        let i = 0;
        for (const session of sessions ?? []) {
            if (i++ > 0 && staggerMs > 0) {
                await new Promise(r => setTimeout(r, staggerMs));
            }
            await this.startListener(session.user_id, session.session_string);
        }
        this.subscribeToChannelChanges();
    }
    /**
     * Subscribe to Supabase Realtime postgres_changes on telegram_channels.
     * When a user toggles a channel on/off the relevant listener rebinds
     * its NewMessage filter immediately instead of waiting up to 60s for
     * the safety poll inside UserListener.
     */
    subscribeToChannelChanges() {
        if (this.channelChannel)
            return;
        this.channelChannel = this.supabase
            .channel('telegram_channels_changes')
            .on(
        // postgres_changes is provided via the realtime-js add-on; the
        // type is a string literal not present in supabase-js core types,
        // hence the explicit cast.
        'postgres_changes', { event: '*', schema: 'public', table: 'telegram_channels' }, (payload) => {
            const userId = (payload.new?.user_id ?? payload.old?.user_id);
            if (!userId)
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
        const { data: sessions } = await this.supabase
            .from('telegram_sessions')
            .select('user_id, session_string, is_active');
        const activeSessions = new Set((sessions ?? []).filter(s => s.is_active).map(s => s.user_id));
        for (const session of sessions ?? []) {
            if (session.is_active && !this.listeners.has(session.user_id)) {
                await this.startListener(session.user_id, session.session_string);
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
    /**
     * Channel-attached copier signals should only execute when this worker holds
     * a live MTProto session for the user; otherwise parsed rows (Realtime/sweep)
     * can still fire orders while Telegram is down or on another host.
     */
    canExecuteTelegramCopierTrades(userId) {
        const listener = this.listeners.get(userId);
        if (!listener)
            return false;
        return listener.isTelegramConnected();
    }
    getStatus() {
        const out = [];
        for (const [, listener] of this.listeners) {
            out.push(listener.getStatus());
        }
        return out;
    }
    /**
     * Take ownership of an already-connected, authenticated TelegramClient
     * (e.g. one produced by AuthService.verifyCode) and run it as the
     * long-lived listener. Avoids the second connect from the same host
     * that previously came from the worker spinning up its own client.
     */
    async adoptClient(userId, client, sessionString) {
        await this.stopListener(userId);
        const listener = new userListener_1.UserListener(userId, sessionString, this.supabase, client);
        if (this.tradeExecutor) {
            listener.setOnSignalParsed(row => this.tradeExecutor.dispatchParsedSignal(row));
        }
        await listener.start({ alreadyConnected: true });
        this.listeners.set(userId, listener);
        console.log(`[sessionManager] Adopted live client for user ${userId}`);
    }
    async listChannels(userId) {
        let listener = this.listeners.get(userId);
        if (!listener) {
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
        }
        if (!listener)
            throw new Error('Failed to start listener for user');
        return listener.listChannels();
    }
    async backfillChannelHistory(userId, channelRowId, days) {
        let listener = this.listeners.get(userId);
        if (!listener) {
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
        }
        if (!listener)
            throw new Error('Failed to start listener for user');
        return listener.backfillChannelHistory(channelRowId, days);
    }
    async importBacktestChannelHistory(userId, channelRowId, fromIso, toIso) {
        let listener = this.listeners.get(userId);
        if (!listener) {
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
        }
        if (!listener)
            throw new Error('Failed to start listener for user');
        return listener.importBacktestChannelHistory(channelRowId, fromIso, toIso);
    }
    async syncBacktestSignals(userId, channelRowId, fromIso, toIso, runId) {
        let listener = this.listeners.get(userId);
        if (!listener) {
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
        }
        if (!listener)
            throw new Error('Failed to start listener for user');
        return listener.syncBacktestSignals(channelRowId, fromIso, toIso, { runId });
    }
    async startListener(userId, sessionString) {
        if (this.listeners.has(userId))
            return;
        try {
            const listener = new userListener_1.UserListener(userId, sessionString, this.supabase);
            if (this.tradeExecutor) {
                listener.setOnSignalParsed(row => this.tradeExecutor.dispatchParsedSignal(row));
            }
            await listener.start();
            this.listeners.set(userId, listener);
            console.log(`[sessionManager] Started listener for user ${userId}`);
        }
        catch (err) {
            console.error(`[sessionManager] Failed to start listener for ${userId}:`, err);
        }
    }
    async stopListener(userId) {
        const listener = this.listeners.get(userId);
        if (!listener)
            return;
        await listener.stop();
        this.listeners.delete(userId);
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
            console.log(`[sessionManager] Disconnected ${userId}`);
        }
        this.listeners.clear();
    }
}
exports.UserSessionManager = UserSessionManager;
